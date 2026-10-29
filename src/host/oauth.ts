import { createHash, randomBytes } from 'node:crypto'

import { ConnectError } from './errors.js'

const REQUEST_TIMEOUT_MS = 12_000

export interface OAuthMetadata {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  scope: string
  /** RFC 8707 资源标识；部分服务（如天眼查）会校验它必须等于 MCP 端点 */
  resource?: string
  /** 授权 URL 的固定附加参数，例如百度网盘的 qrcode=1 */
  authorizeParams?: Record<string, string>
}

export interface OAuthClient {
  clientId: string
  clientSecret?: string
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

async function getJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new ConnectError(
      'oauth_unreachable',
      `无法访问 OAuth 服务：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    // 非 JSON 响应按状态码报错
  }
  if (!response.ok) {
    const detail = typeof body.error_description === 'string'
      ? body.error_description
      : typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status}`
    throw new ConnectError('oauth_failed', `OAuth 请求失败：${detail}`)
  }
  return body
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

// 401 的 WWW-Authenticate 里可能直接给出 resource_metadata 地址（RFC 9728），优先用它
async function advertisedResourceMetadata(resource: string): Promise<string | undefined> {
  try {
    const response = await fetch(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-connectors', version: '0.1.0' },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    })
    const header = response.headers.get('www-authenticate') ?? ''
    return /resource_metadata="([^"]+)"/i.exec(header)?.[1]
  } catch {
    return undefined
  }
}

// 两种 well-known 拼法都要兼容：{origin}/.well-known/...{path} 与 {resource}/.well-known/...
async function fetchResourceMetadata(resource: string): Promise<Record<string, unknown>> {
  const resourceUrl = new URL(resource)
  const candidates: string[] = []
  const advertised = await advertisedResourceMetadata(resource)
  if (advertised !== undefined) candidates.push(advertised)
  const suffix = `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`
  candidates.push(suffix.replace(/\/$/, ''))
  candidates.push(`${resource.replace(/\/+$/, '')}/.well-known/oauth-protected-resource`)

  let firstError: unknown
  for (const candidate of [...new Set(candidates)]) {
    try {
      return await getJson(candidate)
    } catch (error) {
      firstError ??= error
    }
  }
  throw firstError
}

export async function fetchOAuthMetadata(resource: string): Promise<OAuthMetadata> {
  const resourceUrl = new URL(resource)
  const resourceMetadata = await fetchResourceMetadata(resource)
  const issuer = asStringList(resourceMetadata.authorization_servers)[0] ?? resourceUrl.origin
  const serverMetadata = await getJson(`${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`)

  const authorizationEndpoint = asString(serverMetadata.authorization_endpoint)
  const tokenEndpoint = asString(serverMetadata.token_endpoint)
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    throw new ConnectError('oauth_failed', 'OAuth 元数据缺少授权端点或令牌端点')
  }
  const scope = asStringList(resourceMetadata.scopes_supported)[0]
    ?? (asStringList(serverMetadata.scopes_supported).includes('mcp')
      ? 'mcp'
      : asStringList(serverMetadata.scopes_supported)[0])
    ?? 'mcp'

  return {
    authorizationEndpoint,
    tokenEndpoint,
    ...(asString(serverMetadata.registration_endpoint) === undefined
      ? {}
      : { registrationEndpoint: asString(serverMetadata.registration_endpoint) }),
    scope,
    resource: asString(resourceMetadata.resource) ?? resource,
  }
}

export async function registerOAuthClient(
  metadata: OAuthMetadata,
  redirectUri: string,
  clientName: string,
): Promise<OAuthClient> {
  if (metadata.registrationEndpoint === undefined) {
    throw new ConnectError('oauth_failed', 'OAuth 服务未提供动态客户端注册端点')
  }
  const body = await getJson(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(metadata.scope === '' ? {} : { scope: metadata.scope }),
    }),
  })
  const clientId = asString(body.client_id)
  if (clientId === undefined) throw new ConnectError('oauth_failed', 'OAuth 动态注册未返回 client_id')
  return {
    clientId,
    ...(asString(body.client_secret) === undefined ? {} : { clientSecret: asString(body.client_secret) }),
  }
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function createState(): string {
  return randomBytes(24).toString('base64url')
}

export function buildAuthorizeUrl(
  metadata: OAuthMetadata,
  options: { clientId: string; redirectUri: string; state: string; challenge?: string },
): string {
  const url = new URL(metadata.authorizationEndpoint)
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', options.state)
  if (metadata.scope !== '') url.searchParams.set('scope', metadata.scope)
  if (options.challenge !== undefined) {
    url.searchParams.set('code_challenge', options.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  if (metadata.resource !== undefined) url.searchParams.set('resource', metadata.resource)
  for (const [key, value] of Object.entries(metadata.authorizeParams ?? {})) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

function parseTokens(body: Record<string, unknown>): OAuthTokens {
  const accessToken = asString(body.access_token)
  if (accessToken === undefined) throw new ConnectError('oauth_failed', 'OAuth 未返回访问令牌')
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined
  return {
    accessToken,
    ...(asString(body.refresh_token) === undefined ? {} : { refreshToken: asString(body.refresh_token) }),
    ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + expiresIn * 1000 }),
    ...(asString(body.scope) === undefined ? {} : { scope: asString(body.scope) }),
  }
}

export async function exchangeCode(
  tokenEndpoint: string,
  options: {
    code: string
    redirectUri: string
    clientId: string
    clientSecret?: string
    verifier?: string
    resource?: string
    tokenMethod?: 'POST' | 'GET'
  },
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
  })
  if (options.verifier !== undefined) params.set('code_verifier', options.verifier)
  if (options.clientSecret !== undefined) params.set('client_secret', options.clientSecret)
  if (options.resource !== undefined) params.set('resource', options.resource)
  const body = options.tokenMethod === 'GET'
    ? await getJson(`${tokenEndpoint}${tokenEndpoint.includes('?') ? '&' : '?'}${params.toString()}`)
    : await getJson(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
  return parseTokens(body)
}

export async function refreshAccessToken(
  tokenEndpoint: string,
  options: {
    refreshToken: string
    clientId: string
    clientSecret?: string
    resource?: string
    tokenMethod?: 'POST' | 'GET'
  },
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  })
  if (options.clientSecret !== undefined) params.set('client_secret', options.clientSecret)
  if (options.resource !== undefined) params.set('resource', options.resource)
  const body = options.tokenMethod === 'GET'
    ? await getJson(`${tokenEndpoint}${tokenEndpoint.includes('?') ? '&' : '?'}${params.toString()}`)
    : await getJson(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
  return parseTokens(body)
}
