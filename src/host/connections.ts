import type { Domain } from '@deepseek-ai/dsh-storage-domain'

import type { CardAuth, ConnectorCard, ConnectionView, CustomConfigView, ToolInfo } from '../shared/types.js'
import { MAX_EXAMPLES, resolveCategory, validateCategory } from '../shared/categories.js'
import { CUSTOM_SECRET_PLACEHOLDER } from '../shared/customConfig.js'
import { ROUTE_PREFIX } from '../shared/types.js'
import { ConnectError } from './errors.js'
import { resolveInstanceMcpUrl } from './instanceUrl.js'
import { assertPrivateUrlsAllowed, parseMcpServers } from './mcpServers.js'
import { openExternal } from './openExternal.js'
import {
  buildAuthorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  fetchOAuthMetadata,
  refreshAccessToken,
  registerOAuthClient,
  type OAuthClient,
  type OAuthMetadata,
} from './oauth.js'
import { defineConnectorDomain, type ConnectionRecord, type CustomConnectorRecord } from './store.js'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const ENTRY_PREFIX = 'dsh-connectors'
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000
const OAUTH_FLOW_TTL_MS = 2 * 60 * 1000
const OAUTH_REFRESH_SKEW_MS = 60 * 1000
const OAUTH_METADATA_TTL_MS = 10 * 60 * 1000
// GitLab.com 的 initialize + tools/list 实测可达 15s，5s 会让正常连接误判失败
const TOOL_WAIT_TIMEOUT_MS = 30_000

interface OAuthPending {
  connectorId: string
  verifier: string
  redirectUri: string
  client: OAuthClient
  metadata: OAuthMetadata
  serverUrl: string
  createdAt: number
}

interface OAuthFlow {
  connectorId: string
  status: 'pending' | 'done' | 'error'
  message?: string
  createdAt: number
}

interface LoaderFace {
  resolve: (id: string) => { options?: { config?: Record<string, unknown> } } | undefined
  create: (options: { id: string; name: string; config: Record<string, unknown>; disabled?: boolean }) => Promise<unknown>
  update: (id: string, options: { config?: Record<string, unknown>; disabled?: boolean }) => Promise<unknown>
  remove: (id: string) => Promise<unknown>
}

interface ToolsFace {
  schemas?: () => Array<{ name?: string; description?: string }>
}

interface StorageDomainFace {
  open: (spec: ReturnType<typeof defineConnectorDomain>) => Promise<Domain<ReturnType<typeof defineConnectorDomain>>>
}

export interface ConnectionContext {
  loader?: LoaderFace
  tools?: ToolsFace
  storageDomain?: StorageDomainFace
}

function entryId(connectorId: string): string {
  return `${ENTRY_PREFIX}-${connectorId}`
}

function headersFor(record: ConnectionRecord): Record<string, string> {
  const headers = { ...(record.headers ?? {}) }
  if (record.oauth !== undefined) {
    headers.Authorization = `Bearer ${record.oauth.accessToken}`
  } else if (record.auth !== undefined) {
    headers[record.auth.header] = `${record.auth.prefix}${record.auth.token}`
  }
  return headers
}

function redactCustomUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.search === '' && url.hash === '') return value
    return `${url.origin}${url.pathname}?${CUSTOM_SECRET_PLACEHOLDER}`
  } catch {
    return value
  }
}

function restoreCustomUrl(value: string, previous: string | undefined): string {
  const marker = `?${CUSTOM_SECRET_PLACEHOLDER}`
  if (!value.endsWith(marker) || previous === undefined) return value
  try {
    const url = new URL(previous)
    return `${value.slice(0, -marker.length)}${url.search}${url.hash}`
  } catch {
    return value
  }
}

function redactValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(values).map(key => [key, CUSTOM_SECRET_PLACEHOLDER]))
}

function mergeSecretValues(
  next: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
  label: string,
): Record<string, string> | undefined {
  if (next === undefined) return undefined
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(next)) {
    if (value !== CUSTOM_SECRET_PLACEHOLDER) {
      merged[key] = value
      continue
    }
    const stored = previous?.[key]
    if (stored === undefined) {
      throw new ConnectError(
        'invalid_custom_config',
        `${label}.${key} 是占位值，但没有已保存的值，请填写新值`,
      )
    }
    merged[key] = stored
  }
  return merged
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function sameStringMap(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

function sameConnectionConfig(
  left: CustomConnectorRecord,
  right: CustomConnectorRecord,
): boolean {
  return left.url === right.url
    && left.command === right.command
    && left.cwd === right.cwd
    && sameStringArray(left.args, right.args)
    && sameStringMap(left.env, right.env)
    && sameStringMap(left.headers, right.headers)
}

function entryConfig(record: ConnectionRecord, failOnStartupError: boolean): Record<string, unknown> {
  if (record.transport === 'stdio') {
    if (record.command === undefined) throw new ConnectError('invalid_connector', 'stdio 连接缺少启动命令')
    return {
      transport: 'stdio',
      serverName: record.serverName,
      command: record.command,
      args: record.args ?? [],
      ...(record.env === undefined ? {} : { env: record.env }),
      ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
      failOnStartupError,
    }
  }
  if (record.url === undefined) throw new ConnectError('invalid_connector', 'HTTP 连接缺少地址')
  return {
    transport: 'streamable-http',
    serverName: record.serverName,
    url: record.url,
    headers: headersFor(record),
    failOnStartupError,
  }
}

function secretValues(record: ConnectionRecord): string[] {
  const values = [
    ...(record.auth === undefined ? [] : [record.auth.token]),
    ...(record.oauth === undefined
      ? []
      : [
          record.oauth.accessToken,
          ...(record.oauth.refreshToken === undefined ? [] : [record.oauth.refreshToken]),
          ...(record.oauth.clientSecret === undefined ? [] : [record.oauth.clientSecret]),
        ]),
    ...Object.values(record.headers ?? {}),
    ...Object.values(record.env ?? {}),
  ]
  return values.filter(value => value.length >= 4).sort((left, right) => right.length - left.length)
}

function describeError(error: unknown, record?: ConnectionRecord): string {
  let message = error instanceof Error ? error.message : String(error)
  if (record !== undefined) {
    for (const secret of secretValues(record)) message = message.split(secret).join('***')
  }
  return message.length > 600 ? `${message.slice(0, 600)}…` : message
}

function parseRedirectUri(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConnectError('invalid_request', 'OAuth 回调地址不合法')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.pathname !== `${ROUTE_PREFIX}/api/oauth/callback`
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new ConnectError('invalid_request', 'OAuth 回调地址不合法')
  }
  const host = url.hostname
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw new ConnectError('invalid_request', 'OAuth 回调地址必须是本机地址')
  }
  return url.toString()
}

export class ConnectionService {
  private readonly domainPromise: Promise<Domain<ReturnType<typeof defineConnectorDomain>>>
  private readonly oauthPending = new Map<string, OAuthPending>()
  private readonly oauthFlows = new Map<string, OAuthFlow>()
  private readonly oauthClients = new Map<string, OAuthClient>()
  private readonly oauthMetadata = new Map<string, { metadata: OAuthMetadata; at: number }>()
  private disposing = false

  constructor(
    private readonly ctx: ConnectionContext,
    private readonly catalog: () => ConnectorCard[],
  ) {
    if (ctx.loader === undefined) throw new Error('loader service is unavailable')
    if (ctx.storageDomain === undefined) throw new Error('storageDomain service is unavailable')
    this.domainPromise = ctx.storageDomain.open(defineConnectorDomain())
  }

  private async table() {
    const domain = await this.domainPromise
    return domain.table('connections')
  }

  private async customTable() {
    const domain = await this.domainPromise
    return domain.table('custom_connectors')
  }

  async dispose(): Promise<void> {
    this.disposing = true
    const domain = await this.domainPromise
    await domain.close()
  }

  async list(): Promise<ConnectionView[]> {
    const table = await this.table()
    return [...table.entries()].map(([, record]) => this.view(record))
  }

  async listCards(): Promise<ConnectorCard[]> {
    const customTable = await this.customTable()
    const custom = [...customTable.entries()]
      .sort(([, left], [, right]) => left.createdAt - right.createdAt)
      .map(([, record]) => this.customCard(record))
    return [...this.catalog(), ...custom]
  }

  async restore(): Promise<void> {
    const table = await this.table()
    for (const [, record] of table.entries()) {
      if (!record.enabled || this.disposing) continue
      if (this.needsAuth(this.cardFor(record.connectorId)) && record.auth === undefined && record.oauth === undefined) continue
      try {
        const fresh = await this.ensureFreshOAuth(record)
        if (fresh !== record) await table.put(fresh.key, fresh)
        await this.provision(fresh, false)
      } catch (error) {
        await this.rememberError(record.key, describeError(error, record))
      }
    }
  }

  async connect(connectorId: string, token?: string, instanceUrl?: string): Promise<ConnectionView> {
    const builtinCard = this.catalog().find(item => item.id === connectorId)
    const table = await this.table()
    const previous = table.get(connectorId)
    const now = Date.now()
    let record: ConnectionRecord

    if (builtinCard !== undefined && builtinCard.published) {
      if (builtinCard.auth.type === 'oauth2') return this.installOAuth(builtinCard, instanceUrl)
      if (
        (builtinCard.auth.type === 'bearer' || builtinCard.auth.type === 'header')
        && (token === undefined || token.trim() === '')
      ) {
        return this.installToken(builtinCard)
      }
      const server = builtinCard.server
      record = {
        key: builtinCard.id,
        connectorId: builtinCard.id,
        name: builtinCard.name,
        serverName: server.serverName,
        transport: server.transport,
        url: server.url,
        command: server.command,
        args: server.args,
        auth: this.authFor(builtinCard, token),
        enabled: true,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
    } else {
      const custom = (await this.customTable()).get(connectorId)
      if (custom === undefined) throw new ConnectError('not_found', '连接器不存在或未发布')
      record = {
        key: custom.connectorId,
        connectorId: custom.connectorId,
        name: custom.name,
        serverName: custom.serverName,
        transport: custom.transport,
        url: custom.url,
        command: custom.command,
        args: custom.args,
        env: custom.env,
        cwd: custom.cwd,
        headers: custom.headers,
        enabled: true,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
    }

    try {
      await this.provision(record, true)
      const timeoutMs = TOOL_WAIT_TIMEOUT_MS
      const tools = await this.waitForTools(record.serverName, timeoutMs)
      if (tools.length === 0) {
        await this.removeEntry(record.connectorId)
        const hint = record.transport === 'stdio' ? '启动命令或环境' : '服务地址或凭据'
        throw new ConnectError('connect_failed', `连接已提交，但 ${timeoutMs / 1000} 秒内没有发现工具，请检查${hint}`)
      }
    } catch (error) {
      if (previous !== undefined) await this.rememberError(record.key, describeError(error, record))
      if (error instanceof ConnectError) throw error
      throw new ConnectError('connect_failed', describeError(error, record))
    }

    await table.put(record.key, record)
    return this.view(record)
  }

  async disconnect(connectorId: string): Promise<void> {
    const table = await this.table()
    await this.removeEntry(connectorId)
    await table.delete(connectorId)
  }

  async revokeOAuth(connectorId: string): Promise<ConnectionView> {
    const table = await this.table()
    const record = table.get(connectorId)
    if (record === undefined) throw new ConnectError('not_found', '连接记录不存在')
    if (record.oauth === undefined) return this.view(record)

    await this.removeEntry(connectorId)
    const { oauth: _oauth, ...rest } = record
    const updated: ConnectionRecord = {
      ...rest,
      enabled: true,
      lastError: undefined,
      updatedAt: Date.now(),
    }
    await table.put(connectorId, updated)
    return this.view(updated)
  }

  async reconfigureInstance(connectorId: string, instanceUrl: string): Promise<ConnectionView> {
    const card = this.catalog().find(item => item.id === connectorId)
    if (card === undefined || !card.published || card.instance === undefined || card.auth.type !== 'oauth2') {
      throw new ConnectError('not_found', '连接器不存在或不支持更换实例')
    }
    const table = await this.table()
    const previous = table.get(connectorId)
    if (previous === undefined) throw new ConnectError('not_installed', '请先安装连接器')

    const resolved = resolveInstanceMcpUrl(instanceUrl)
    const url = card.server.url?.replace('{instance}', resolved.instanceUrl)
    if (url === undefined || url.includes('{instance}')) {
      throw new ConnectError('invalid_connector', '连接器地址模板不合法')
    }

    for (const [state, pending] of this.oauthPending) {
      if (pending.connectorId === connectorId) this.oauthPending.delete(state)
    }
    for (const [state, flow] of this.oauthFlows) {
      if (flow.connectorId === connectorId) this.oauthFlows.delete(state)
    }

    if (previous.url === url) return this.view(previous)

    await this.removeEntry(connectorId)
    const { oauth: _oauth, auth: _auth, ...rest } = previous
    const updated: ConnectionRecord = {
      ...rest,
      url,
      enabled: true,
      lastError: undefined,
      updatedAt: Date.now(),
    }
    await table.put(connectorId, updated)
    return this.view(updated)
  }

  async setEnabled(connectorId: string, enabled: boolean): Promise<ConnectionView> {
    const table = await this.table()
    const record = table.get(connectorId)
    if (record === undefined) throw new ConnectError('not_found', '连接记录不存在')
    if (record.enabled === enabled) return this.view(record)

    if (!enabled) {
      await this.removeEntry(connectorId)
      const updated: ConnectionRecord = {
        ...record,
        enabled: false,
        lastError: undefined,
        updatedAt: Date.now(),
      }
      await table.put(connectorId, updated)
      return this.view(updated)
    }

    if (this.needsAuth(this.cardFor(connectorId)) && record.auth === undefined && record.oauth === undefined) {
      const updated: ConnectionRecord = {
        ...record,
        enabled: true,
        lastError: undefined,
        updatedAt: Date.now(),
      }
      await table.put(connectorId, updated)
      return this.view(updated)
    }

    const updated: ConnectionRecord = {
      ...record,
      enabled: true,
      lastError: undefined,
      updatedAt: Date.now(),
    }
    let fresh = updated
    try {
      fresh = await this.ensureFreshOAuth(updated)
      await this.provision(fresh, true)
      const timeoutMs = TOOL_WAIT_TIMEOUT_MS
      const tools = await this.waitForTools(fresh.serverName, timeoutMs)
      if (tools.length === 0) {
        await this.removeEntry(connectorId)
        const hint = fresh.transport === 'stdio' ? '启动命令或环境' : '服务地址或凭据'
        throw new ConnectError('connect_failed', `启用失败：${timeoutMs / 1000} 秒内没有发现工具，请检查${hint}`)
      }
    } catch (error) {
      await this.removeEntry(connectorId).catch(() => undefined)
      const message = describeError(error, fresh)
      await table.put(connectorId, {
        ...fresh,
        enabled: false,
        lastError: message,
        updatedAt: Date.now(),
      })
      if (error instanceof ConnectError) throw error
      throw new ConnectError('connect_failed', message)
    }
    await table.put(connectorId, fresh)
    return this.view(fresh)
  }

  private async installOAuth(card: ConnectorCard, instanceUrl?: string): Promise<ConnectionView> {
    if (card.auth.type !== 'oauth2') {
      throw new ConnectError('oauth_required', `${card.name} 需要 OAuth 授权，请使用授权流程`)
    }
    const server = card.server

    const table = await this.table()
    const previous = table.get(card.id)
    if (previous?.oauth !== undefined) return this.view(previous)

    let url: string | undefined
    if (card.instance !== undefined) {
      if (instanceUrl !== undefined && instanceUrl.trim() !== '') {
        const resolved = resolveInstanceMcpUrl(instanceUrl)
        url = server.url?.replace('{instance}', resolved.instanceUrl)
        if (url === undefined || url.includes('{instance}')) {
          throw new ConnectError('invalid_connector', '连接器地址模板不合法')
        }
      } else {
        url = previous?.url
      }
    } else {
      if (server.url === undefined) throw new ConnectError('invalid_connector', '连接器没有可用的 MCP Server')
      url = server.url
    }

    const now = Date.now()
    const record: ConnectionRecord = {
      key: card.id,
      connectorId: card.id,
      name: card.name,
      serverName: server.serverName,
      transport: server.transport,
      url,
      command: server.command,
      args: server.args,
      enabled: true,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    await this.removeEntry(card.id)
    await table.put(record.key, record)
    return this.view(record)
  }

  private async installToken(card: ConnectorCard): Promise<ConnectionView> {
    const server = card.server

    const table = await this.table()
    const previous = table.get(card.id)
    if (previous?.auth !== undefined) return this.view(previous)

    const now = Date.now()
    const record: ConnectionRecord = {
      key: card.id,
      connectorId: card.id,
      name: card.name,
      serverName: server.serverName,
      transport: server.transport,
      url: server.url,
      command: server.command,
      args: server.args,
      enabled: true,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    await this.removeEntry(card.id)
    await table.put(record.key, record)
    return this.view(record)
  }

  private needsAuth(card: ConnectorCard | undefined): boolean {
    return card?.auth.type === 'oauth2' || card?.auth.type === 'bearer' || card?.auth.type === 'header'
  }

  private cardFor(connectorId: string): ConnectorCard | undefined {
    return this.catalog().find(item => item.id === connectorId)
  }

  async startOAuth(connectorId: string, redirectUri: string): Promise<{ authorizeUrl: string; flowId: string; opened: boolean }> {
    const card = this.catalog().find(item => item.id === connectorId)
    if (card === undefined || !card.published || card.auth.type !== 'oauth2') {
      throw new ConnectError('not_found', '连接器不存在或未发布')
    }

    const redirect = parseRedirectUri(redirectUri)
    const table = await this.table()
    const previous = table.get(connectorId)
    if (previous === undefined) {
      throw new ConnectError('not_installed', '请先安装连接器，再发起授权')
    }
    const serverUrl = previous.url
    if (serverUrl === undefined) {
      throw card.instance !== undefined
        ? new ConnectError('instance_required', '请先填写实例地址')
        : new ConnectError('invalid_connector', '连接记录缺少服务地址')
    }
    const cachedMetadata = this.oauthMetadata.get(serverUrl)
    const baseMetadata = cachedMetadata !== undefined && Date.now() - cachedMetadata.at < OAUTH_METADATA_TTL_MS
      ? cachedMetadata.metadata
      : await fetchOAuthMetadata(serverUrl)
    this.oauthMetadata.set(serverUrl, { metadata: baseMetadata, at: Date.now() })

    const auth = card.auth
    const scope = auth.scopes !== undefined && auth.scopes.length > 0
      ? auth.scopes.join(' ')
      : baseMetadata.scope
    const metadata: OAuthMetadata = { ...baseMetadata, scope }
    const clientKey = `${serverUrl}|${redirect}`
    const cached = auth.registration === 'dcr' ? this.oauthClients.get(clientKey) : undefined
    const previousClient = previous.oauth !== undefined
      && previous.oauth.redirectUri === redirect
      && (auth.registration === 'dcr' || auth.registration.clientId === previous.oauth.clientId)
      ? { clientId: previous.oauth.clientId, clientSecret: previous.oauth.clientSecret }
      : undefined
    const client = previousClient ?? cached ?? await this.oauthClientFor(auth, metadata, redirect)
    if (auth.registration === 'dcr') this.oauthClients.set(clientKey, client)

    const { verifier, challenge } = createPkce()
    const state = createState()
    const now = Date.now()
    this.pruneOAuthPending()
    this.pruneOAuthFlows()
    this.oauthPending.set(state, {
      connectorId,
      verifier,
      redirectUri: redirect,
      client,
      metadata,
      serverUrl,
      createdAt: now,
    })
    this.oauthFlows.set(state, { connectorId, status: 'pending', createdAt: now })
    const authorizeUrl = buildAuthorizeUrl(metadata, {
      clientId: client.clientId,
      redirectUri: redirect,
      state,
      challenge,
    })
    const opened = await openExternal(authorizeUrl)
    return { authorizeUrl, flowId: state, opened }
  }

  private async oauthClientFor(
    auth: Extract<CardAuth, { type: 'oauth2' }>,
    metadata: OAuthMetadata,
    redirect: string,
  ): Promise<OAuthClient> {
    if (auth.registration === 'dcr') {
      if (metadata.registrationEndpoint === undefined) {
        throw new ConnectError('oauth_failed', '该 GitLab 实例未提供动态客户端注册，暂不支持；请升级实例或使用自定义连接器')
      }
      return registerOAuthClient(metadata, redirect, auth.clientName ?? 'DSH 连接器')
    }
    return { clientId: auth.registration.clientId }
  }

  async completeOAuth(state: string, code: string): Promise<ConnectionView> {
    this.pruneOAuthPending()
    const pending = this.oauthPending.get(state)
    if (pending === undefined) {
      throw new ConnectError('oauth_state_invalid', '授权状态无效或已过期，请回到连接器面板重新授权')
    }
    this.oauthPending.delete(state)
    try {
      const view = await this.finishOAuth(pending, code)
      this.oauthFlows.set(state, {
        connectorId: pending.connectorId,
        status: 'done',
        createdAt: pending.createdAt,
      })
      return view
    } catch (error) {
      this.oauthFlows.set(state, {
        connectorId: pending.connectorId,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        createdAt: pending.createdAt,
      })
      throw error
    }
  }

  oauthFlowStatus(flowId: string): { status: 'pending' | 'done' | 'error' | 'expired'; message?: string } {
    this.pruneOAuthFlows()
    const flow = this.oauthFlows.get(flowId)
    if (flow === undefined) return { status: 'expired' }
    return {
      status: flow.status,
      ...(flow.message === undefined ? {} : { message: flow.message }),
    }
  }

  failOAuthFlow(flowId: string, message: string): void {
    this.pruneOAuthFlows()
    const flow = this.oauthFlows.get(flowId)
    if (flow === undefined) return
    this.oauthPending.delete(flowId)
    this.oauthFlows.set(flowId, { ...flow, status: 'error', message })
  }

  cancelOAuth(flowId: string): void {
    this.pruneOAuthPending()
    this.oauthPending.delete(flowId)
    this.oauthFlows.delete(flowId)
  }

  private async finishOAuth(pending: OAuthPending, code: string): Promise<ConnectionView> {
    const card = this.catalog().find(item => item.id === pending.connectorId)
    if (card === undefined || !card.published) throw new ConnectError('not_found', '连接器已下架')
    const server = card.server

    const tokens = await exchangeCode(pending.metadata.tokenEndpoint, {
      code,
      redirectUri: pending.redirectUri,
      clientId: pending.client.clientId,
      ...(pending.client.clientSecret === undefined ? {} : { clientSecret: pending.client.clientSecret }),
      verifier: pending.verifier,
    })

    const table = await this.table()
    const previous = table.get(card.id)
    const now = Date.now()
    const record: ConnectionRecord = {
      key: card.id,
      connectorId: card.id,
      name: card.name,
      serverName: server.serverName,
      transport: server.transport,
      url: pending.serverUrl,
      command: server.command,
      args: server.args,
      oauth: {
        provider: card.id,
        clientId: pending.client.clientId,
        ...(pending.client.clientSecret === undefined ? {} : { clientSecret: pending.client.clientSecret }),
        redirectUri: pending.redirectUri,
        tokenEndpoint: pending.metadata.tokenEndpoint,
        authorizationEndpoint: pending.metadata.authorizationEndpoint,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
        ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
        scope: tokens.scope ?? pending.metadata.scope,
      },
      enabled: true,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }

    try {
      await this.provision(record, true)
      const tools = await this.waitForTools(record.serverName, TOOL_WAIT_TIMEOUT_MS)
      if (tools.length === 0) {
        await this.removeEntry(record.connectorId)
        throw new ConnectError('connect_failed', `授权成功，但 ${TOOL_WAIT_TIMEOUT_MS / 1000} 秒内没有发现 ${card.name} 工具，请稍后重试`)
      }
    } catch (error) {
      await this.removeEntry(record.connectorId).catch(() => undefined)
      const message = describeError(error, record)
      await table.put(record.key, {
        ...record,
        enabled: false,
        lastError: message,
        updatedAt: Date.now(),
      })
      if (error instanceof ConnectError) throw error
      throw new ConnectError('connect_failed', message)
    }

    await table.put(record.key, record)
    return this.view(record)
  }

  private async ensureFreshOAuth(record: ConnectionRecord): Promise<ConnectionRecord> {
    const oauth = record.oauth
    if (oauth === undefined || oauth.expiresAt === undefined) return record
    if (oauth.expiresAt - Date.now() > OAUTH_REFRESH_SKEW_MS) return record
    if (oauth.refreshToken === undefined) {
      throw new ConnectError('oauth_expired', `${record.name} 授权已过期，请回到连接器面板重新授权`)
    }
    const tokens = await refreshAccessToken(oauth.tokenEndpoint, {
      refreshToken: oauth.refreshToken,
      clientId: oauth.clientId,
      ...(oauth.clientSecret === undefined ? {} : { clientSecret: oauth.clientSecret }),
    })
    return {
      ...record,
      oauth: {
        ...oauth,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? oauth.refreshToken,
        expiresAt: tokens.expiresAt ?? oauth.expiresAt,
        scope: tokens.scope ?? oauth.scope,
      },
      updatedAt: Date.now(),
    }
  }

  private pruneOAuthPending(): void {
    const now = Date.now()
    for (const [state, pending] of this.oauthPending) {
      if (now - pending.createdAt > OAUTH_PENDING_TTL_MS) this.oauthPending.delete(state)
    }
  }

  private pruneOAuthFlows(): void {
    const now = Date.now()
    for (const [state, flow] of this.oauthFlows) {
      const ttl = flow.status === 'pending' ? OAUTH_PENDING_TTL_MS : OAUTH_FLOW_TTL_MS
      if (now - flow.createdAt > ttl) this.oauthFlows.delete(state)
    }
  }

  async importCustom(
    text: string,
    allowPrivate: boolean,
    options: { category?: string; description?: string; examples?: string[] } = {},
  ): Promise<ConnectorCard[]> {
    const seeds = parseMcpServers(text)
    assertPrivateUrlsAllowed(seeds, allowPrivate)

    if (options.category !== undefined) {
      const problem = validateCategory(options.category)
      if (problem !== undefined) throw new ConnectError('invalid_category', problem)
    }
    const batchDescription = options.description?.trim()
    if (batchDescription !== undefined && batchDescription !== '' && Array.from(batchDescription).length > 120) {
      throw new ConnectError('invalid_description', '描述最多 120 字')
    }
    const batchExamples = options.examples === undefined
      ? undefined
      : options.examples.map(item => item.trim()).filter(item => item !== '')
    if (batchExamples !== undefined && batchExamples.length > MAX_EXAMPLES) {
      throw new ConnectError('invalid_examples', `示例提示词最多 ${MAX_EXAMPLES} 条`)
    }
    const categoryOverride = options.category === undefined || options.category.trim() === ''
      ? undefined
      : options.category
    const descriptionOverride = batchDescription === undefined || batchDescription === ''
      ? undefined
      : batchDescription
    const examplesOverride = batchExamples === undefined || batchExamples.length === 0
      ? undefined
      : batchExamples

    const customTable = await this.customTable()
    const connections = await this.table()
    const usedNames = new Set<string>()
    for (const card of this.catalog()) {
      usedNames.add(card.server.serverName)
    }
    for (const [, record] of customTable.entries()) usedNames.add(record.serverName)
    for (const [, record] of connections.entries()) usedNames.add(record.serverName)

    for (const seed of seeds) {
      if (usedNames.has(seed.serverName)) {
        throw new ConnectError('server_name_conflict', `serverName "${seed.serverName}" 已被占用，请改名后重试`)
      }
      usedNames.add(seed.serverName)
    }

    const now = Date.now()
    const cards: ConnectorCard[] = []
    for (const seed of seeds) {
      const rawCategory = categoryOverride ?? seed.category
      if (rawCategory !== undefined) {
        const problem = validateCategory(rawCategory)
        if (problem !== undefined) {
          throw new ConnectError('invalid_category', `${seed.serverName}: ${problem}`)
        }
      }
      const category = resolveCategory(rawCategory)
      const rawDescription = descriptionOverride ?? seed.description
      const description = rawDescription?.trim()
      if (description !== undefined && description !== '' && Array.from(description).length > 120) {
        throw new ConnectError('invalid_description', `${seed.serverName}: 描述最多 120 字`)
      }
      const examples = examplesOverride ?? seed.examples ?? []
      const record: CustomConnectorRecord = {
        key: seed.connectorId,
        connectorId: seed.connectorId,
        name: seed.serverName,
        serverName: seed.serverName,
        transport: seed.transport,
        url: seed.url,
        headers: seed.headers,
        command: seed.command,
        args: seed.args,
        env: seed.env,
        cwd: seed.cwd,
        category,
        ...(description === undefined || description === '' ? {} : { description }),
        ...(examples.length === 0 ? {} : { examples }),
        createdAt: now,
        updatedAt: now,
      }
      await customTable.put(record.key, record)
      cards.push(this.customCard(record))
    }
    return cards
  }

  async removeCustom(connectorId: string): Promise<void> {
    const customTable = await this.customTable()
    if (customTable.get(connectorId) === undefined) {
      throw new ConnectError('not_found', '自定义连接器不存在')
    }
    const connections = await this.table()
    if (connections.get(connectorId) !== undefined) {
      await this.removeEntry(connectorId)
      await connections.delete(connectorId)
    }
    await customTable.delete(connectorId)
  }

  async customConfig(connectorId: string): Promise<CustomConfigView> {
    const record = (await this.customTable()).get(connectorId)
    if (record === undefined) throw new ConnectError('not_found', '自定义连接器不存在')

    const server: Record<string, unknown> = {}
    if (record.url !== undefined) server.url = redactCustomUrl(record.url)
    if (record.command !== undefined) server.command = record.command
    if (record.args !== undefined) server.args = record.args
    if (record.env !== undefined) server.env = redactValues(record.env)
    if (record.cwd !== undefined) server.cwd = record.cwd
    if (record.headers !== undefined) server.headers = redactValues(record.headers)
    const metadata: Record<string, unknown> = {}
    if (record.category !== undefined) metadata.category = record.category
    if (record.description !== undefined) metadata.description = record.description
    if (record.examples !== undefined) metadata.examples = record.examples
    if (Object.keys(metadata).length > 0) server['x-dsh'] = metadata

    const connections = await this.table()
    return {
      json: JSON.stringify({ mcpServers: { [record.serverName]: server } }, null, 2),
      installed: connections.get(connectorId) !== undefined,
    }
  }

  async updateCustom(
    connectorId: string,
    text: string,
    allowPrivate: boolean,
    options: { category?: string; description?: string; examples?: string[] } = {},
  ): Promise<{ card: ConnectorCard; disconnected: boolean }> {
    const customTable = await this.customTable()
    const previous = customTable.get(connectorId)
    if (previous === undefined) throw new ConnectError('not_found', '自定义连接器不存在')

    const seeds = parseMcpServers(text)
    if (seeds.length !== 1) {
      throw new ConnectError('invalid_custom_config', '编辑时只能保留一个 Server')
    }
    const seed = seeds[0]
    if (seed === undefined) {
      throw new ConnectError('invalid_custom_config', '编辑时只能保留一个 Server')
    }
    if (seed.serverName !== previous.serverName) {
      throw new ConnectError('server_name_conflict', '编辑时不能修改 serverName')
    }
    assertPrivateUrlsAllowed(seeds, allowPrivate)

    if (options.category !== undefined) {
      const problem = validateCategory(options.category)
      if (problem !== undefined) throw new ConnectError('invalid_category', problem)
    }
    const batchDescription = options.description?.trim()
    if (batchDescription !== undefined && batchDescription !== '' && Array.from(batchDescription).length > 120) {
      throw new ConnectError('invalid_description', '描述最多 120 字')
    }
    const batchExamples = options.examples === undefined
      ? undefined
      : options.examples.map(item => item.trim()).filter(item => item !== '')
    if (batchExamples !== undefined && batchExamples.length > MAX_EXAMPLES) {
      throw new ConnectError('invalid_examples', `示例提示词最多 ${MAX_EXAMPLES} 条`)
    }

    const rawCategory = options.category ?? seed.category
    if (rawCategory !== undefined) {
      const problem = validateCategory(rawCategory)
      if (problem !== undefined) {
        throw new ConnectError('invalid_category', `${seed.serverName}: ${problem}`)
      }
    }
    const category = resolveCategory(rawCategory)
    const rawDescription = batchDescription === undefined || batchDescription === ''
      ? seed.description
      : batchDescription
    const description = rawDescription?.trim()
    if (description !== undefined && description !== '' && Array.from(description).length > 120) {
      throw new ConnectError('invalid_description', `${seed.serverName}: 描述最多 120 字`)
    }
    const examples = batchExamples !== undefined && batchExamples.length > 0
      ? batchExamples
      : seed.examples ?? []

    const url = seed.url === undefined ? undefined : restoreCustomUrl(seed.url, previous.url)
    if (url !== undefined && url.endsWith(`?${CUSTOM_SECRET_PLACEHOLDER}`)) {
      throw new ConnectError('invalid_custom_config', 'URL 中的占位值没有已保存的查询参数，请填写完整地址')
    }
    const headers = mergeSecretValues(seed.headers, previous.headers, `${seed.serverName}.headers`)
    const env = mergeSecretValues(seed.env, previous.env, `${seed.serverName}.env`)

    const { description: _oldDescription, examples: _oldExamples, ...rest } = previous
    const record: CustomConnectorRecord = {
      ...rest,
      transport: seed.transport,
      url,
      command: seed.command,
      args: seed.args,
      env,
      cwd: seed.cwd,
      headers,
      category,
      ...(description === undefined || description === '' ? {} : { description }),
      ...(examples.length === 0 ? {} : { examples }),
      updatedAt: Date.now(),
    }
    await customTable.put(connectorId, record)

    const changed = !sameConnectionConfig(previous, record)
    let disconnected = false
    if (changed) {
      const connections = await this.table()
      if (connections.get(connectorId) !== undefined) {
        await this.removeEntry(connectorId)
        await connections.delete(connectorId)
        disconnected = true
      }
    }
    return { card: this.customCard(record), disconnected }
  }

  private authFor(card: ConnectorCard, token?: string): ConnectionRecord['auth'] {
    const auth = card.auth
    if (auth.type === 'none') return undefined
    if (auth.type === 'oauth2') {
      throw new ConnectError('oauth_required', `${card.name} 需要 OAuth 授权，请使用安装流程中的授权按钮`)
    }
    const value = token?.trim()
    if (value === undefined || value === '') {
      throw new ConnectError('missing_token', `请填写 ${auth.label}`)
    }
    if (auth.type === 'bearer') {
      return { mode: 'bearer', header: 'Authorization', prefix: 'Bearer ', token: value }
    }
    return { mode: 'api-key', header: auth.header, prefix: auth.prefix ?? '', token: value }
  }

  private toolDetailsFor(serverName: string): ToolInfo[] {
    const schemas = this.ctx.tools?.schemas?.() ?? []
    const prefix = `mcp__${serverName}__`
    return schemas
      .filter(schema => typeof schema.name === 'string' && schema.name.startsWith(prefix))
      .map(schema => ({
        name: schema.name as string,
        ...(typeof schema.description === 'string' && schema.description !== ''
          ? { description: schema.description }
          : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private toolsFor(serverName: string): string[] {
    return this.toolDetailsFor(serverName).map(tool => tool.name)
  }

  private async waitForTools(serverName: string, timeoutMs = 5000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const tools = this.toolsFor(serverName)
      if (tools.length > 0 || Date.now() >= deadline) return tools
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  private view(record: ConnectionRecord): ConnectionView {
    const toolDetails = record.enabled ? this.toolDetailsFor(record.serverName) : []
    const card = this.cardFor(record.connectorId)
    return {
      connectorId: record.connectorId,
      name: record.name,
      serverName: record.serverName,
      transport: record.transport,
      enabled: record.enabled,
      authorized: !this.needsAuth(card) || record.auth !== undefined || record.oauth !== undefined,
      ...(card?.instance === undefined ? {} : { instanceReady: record.url !== undefined }),
      tools: toolDetails.map(tool => tool.name),
      toolDetails,
      error: record.lastError,
      createdAt: record.createdAt,
    }
  }

  private customCard(record: CustomConnectorRecord): ConnectorCard {
    const stdio = record.transport === 'stdio'
    return {
      id: record.connectorId,
      name: record.name,
      vendor: '自定义',
      category: resolveCategory(record.category),
      summary: record.description ?? (stdio
        ? '通过 mcpServers 导入的本地 stdio MCP Server。'
        : '通过 mcpServers 导入的 Streamable HTTP MCP Server。'),
      ...(record.description === undefined ? {} : { description: record.description }),
      ...(record.examples === undefined ? {} : { examples: record.examples }),
      tags: ['自定义', resolveCategory(record.category), record.transport],
      published: true,
      auth: { type: 'none' },
      source: 'custom',
      server: {
        serverName: record.serverName,
        transport: record.transport,
        ...(record.url === undefined ? {} : { url: record.url }),
      },
    }
  }

  private async rememberError(connectorId: string, message: string): Promise<void> {
    const table = await this.table()
    const current = table.get(connectorId)
    if (current === undefined) return
    await table.put(connectorId, { ...current, lastError: message, updatedAt: Date.now() })
  }

  private async provision(record: ConnectionRecord, failOnStartupError: boolean): Promise<void> {
    const loader = this.ctx.loader
    if (loader === undefined) throw new ConnectError('loader_unavailable', 'DSH loader 服务不可用')
    const id = entryId(record.connectorId)
    const config = entryConfig(record, failOnStartupError)
    if (this.hasEntry(id)) {
      await loader.update(id, { config, disabled: false })
    } else {
      await loader.create({ id, name: MCP_CLIENT, config, disabled: false })
    }
  }

  private async removeEntry(connectorId: string): Promise<void> {
    const loader = this.ctx.loader
    if (loader === undefined) return
    const id = entryId(connectorId)
    if (!this.hasEntry(id)) return
    await loader.remove(id)
  }

  private hasEntry(id: string): boolean {
    try {
      return this.ctx.loader?.resolve(id) !== undefined
    } catch {
      return false
    }
  }
}
