import { createHash, randomBytes } from 'node:crypto'

import { ConnectError } from './errors.js'

const REQUEST_TIMEOUT_MS = 12_000

export interface OAuthMetadata {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  scope: string
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

export async function fetchOAuthMetadata(resource: string): Promise<OAuthMetadata> {
  const resourceUrl = new URL(resource)
  const resourceMetadata = await getJson(
    `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`,
  )
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
      scope: metadata.scope,
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
  options: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const url = new URL(metadata.authorizationEndpoint)
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', options.state)
  url.searchParams.set('scope', metadata.scope)
  url.searchParams.set('code_challenge', options.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
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
  options: { code: string; redirectUri: string; clientId: string; clientSecret?: string; verifier: string },
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.verifier,
  })
  if (options.clientSecret !== undefined) params.set('client_secret', options.clientSecret)
  const body = await getJson(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  return parseTokens(body)
}

export async function refreshAccessToken(
  tokenEndpoint: string,
  options: { refreshToken: string; clientId: string; clientSecret?: string },
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  })
  if (options.clientSecret !== undefined) params.set('client_secret', options.clientSecret)
  const body = await getJson(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  return parseTokens(body)
}
