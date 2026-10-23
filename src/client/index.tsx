import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import type { CatalogPayload, ConnectionView, ConnectorCard, ConnectionsPayload, CustomConnectorsPayload, OAuthStartPayload, OAuthStatusPayload, ToolInfo } from '../shared/types.js'
import { ROUTE_PREFIX } from '../shared/types.js'
import { BrandContext7, BrandGithub, BrandGitlab, IconAlert, IconCheck, IconChevronDown, IconClose, IconCode, IconCopy, IconGlobe, IconLink, IconMore, IconPlay, IconPlug, IconPlus, IconSearch, IconTrash } from './icons.js'

export const inject: string[] = []

const PANEL_ID = 'dsh-connectors'
const STYLE_ID = 'dsh-connectors-style'
const PROBE_ROUNDS = 6
const PROBE_INTERVAL_MS = 350
const MCP_SERVERS_PLACEHOLDER = `{
  "mcpServers": {
    "my-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}`

interface SlotsFace {
  inject: (name: string, callback: () => unknown) => unknown
  register: (spec: Record<string, unknown>, component: unknown) => () => void
}

interface WorkspaceFace {
  startSession: (workspaceId: string | undefined, options?: { prompt?: string; clearPreviousDraft?: boolean }) => void
}

export function apply(ctx: Context): () => void {
  installStyles()
  const get = (ctx as Context & { get?: (name: string) => unknown }).get?.bind(ctx)
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const startTrial = (prompt: string): void => {
    const workspace = get?.('uiWorkspace') as WorkspaceFace | undefined
    if (workspace === undefined || typeof workspace.startSession !== 'function') {
      throw new Error('当前 DSH 版本不支持从连接器打开会话')
    }
    workspace.startSession(undefined, { prompt, clearPreviousDraft: true })
  }

  const mount = (round: number): void => {
    if (disposed) return
    const slots = get?.('slots') as SlotsFace | undefined
    if (slots === undefined) {
      if (round < PROBE_ROUNDS) {
        timer = setTimeout(() => mount(round + 1), PROBE_INTERVAL_MS)
      } else {
        console.warn('[dsh-connectors] slots service unavailable; panel not mounted')
      }
      return
    }
    try {
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, () => <Panel startTrial={startTrial} />))
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '连接器' }, PanelIcon))
      console.info('[dsh-connectors] panel registered')
    } catch (error) {
      console.error('[dsh-connectors] panel registration failed', error)
    }

    try {
      slots.inject('conversation.input.left', () =>
        slots.register({ name: 'conversation.input.left', id: `${PANEL_ID}-dock`, order: 20, label: '连接器' }, ConnectorDock))
    } catch (error) {
      console.warn('[dsh-connectors] composer dock slot unavailable', error)
    }

    try {
      slots.inject('conversation.input.overlay', () =>
        slots.register({ name: 'conversation.input.overlay', id: `${PANEL_ID}-popover`, order: 20, label: '连接器' }, ConnectorPopover))
    } catch (error) {
      console.warn('[dsh-connectors] composer overlay slot unavailable', error)
    }
  }

  mount(0)

  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

function PanelIcon(): JSX.Element {
  return <IconPlug size={16} />
}

interface ConnectResponse {
  ok: boolean
  value?: { connection: ConnectionView }
  error?: { code: string; message: string }
}

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
  })
  const body = await response.json() as T & { ok?: boolean; error?: { code?: string; message?: string } }
  if (!response.ok || body.ok === false) {
    throw new ApiError(body.error?.code ?? 'request_failed', body.error?.message ?? `HTTP ${response.status}`)
  }
  return body
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // 页面未聚焦或权限受限时继续走 execCommand
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    area.remove()
  }
  if (!copied) throw new Error('copy failed')
}

interface PanelProps {
  startTrial: (prompt: string) => void
}

function promptForExample(card: ConnectorCard, example: string): string {
  return example.toLowerCase().includes(card.name.toLowerCase()) ? example : `使用 ${card.name}：${example}`
}

function promptForNextExample(card: ConnectorCard): string {
  const examples = card.examples ?? []
  if (examples.length === 0) return `使用 ${card.name} 的工具完成一个简单任务，先列出可用工具。`
  const key = `dsh-connectors:trial-index:${card.id}`
  let index = 0
  try {
    const stored = Number.parseInt(window.localStorage.getItem(key) ?? '', 10)
    if (Number.isFinite(stored) && stored >= 0) index = stored
  } catch {
    index = 0
  }
  const example = examples[index % examples.length]!
  try {
    window.localStorage.setItem(key, String((index + 1) % examples.length))
  } catch {
    // 存储不可用时本次仍使用当前序号
  }
  return promptForExample(card, example)
}

function shortToolName(name: string, serverName?: string): string {
  if (serverName === undefined) return name
  const prefix = `mcp__${serverName}__`
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

const OAUTH_TIMEOUT_MS = 3 * 60 * 1000
const OAUTH_POLL_MS = 1200

function isOAuthCard(card: ConnectorCard): boolean {
  return card.authMode === 'oauth2-pkce' && card.oauthProvider === 'gitlab'
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError('oauth_cancelled', '已取消授权'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ApiError('oauth_cancelled', '已取消授权'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface OAuthFlowInfo {
  flowId: string
  authorizeUrl: string
  opened: boolean
}

async function authorizeConnector(
  card: ConnectorCard,
  options: { signal?: AbortSignal; onFlow?: (flow: OAuthFlowInfo) => void } = {},
): Promise<ConnectionView> {
  const redirectUri = `${window.location.origin}${ROUTE_PREFIX}/api/oauth/callback`
  let response: OAuthStartPayload
  try {
    response = await request<OAuthStartPayload>(`${ROUTE_PREFIX}/api/oauth/start`, {
      method: 'POST',
      body: JSON.stringify({ connectorId: card.id, redirectUri }),
      signal: options.signal,
    })
  } catch (cause) {
    if (options.signal?.aborted) throw new ApiError('oauth_cancelled', '已取消授权')
    throw cause
  }
  const { flowId, authorizeUrl, opened } = response.value
  options.onFlow?.({ flowId, authorizeUrl, opened })
  if (options.signal?.aborted) throw new ApiError('oauth_cancelled', '已取消授权')

  const deadline = Date.now() + OAUTH_TIMEOUT_MS
  for (;;) {
    await sleep(OAUTH_POLL_MS, options.signal)
    let status: OAuthStatusPayload['value'] | undefined
    try {
      const payload = await request<OAuthStatusPayload>(
        `${ROUTE_PREFIX}/api/oauth/status?flowId=${encodeURIComponent(flowId)}`,
        { signal: options.signal },
      )
      status = payload.value
    } catch {
      if (options.signal?.aborted) throw new ApiError('oauth_cancelled', '已取消授权')
    }
    if (status?.status === 'done') {
      let connection: ConnectionView | undefined
      let fetched = false
      try {
        const list = await request<ConnectionsPayload>(`${ROUTE_PREFIX}/api/connections`, {
          signal: options.signal,
        })
        connection = list.value.connections.find(item => item.connectorId === card.id)
        fetched = true
      } catch {
        if (options.signal?.aborted) throw new ApiError('oauth_cancelled', '已取消授权')
      }
      if (fetched) {
        if (connection === undefined) {
          throw new ApiError('oauth_failed', '授权完成，但没有找到连接记录，请刷新面板重试')
        }
        return connection
      }
    }
    if (status?.status === 'error') {
      throw new ApiError('oauth_failed', status.message ?? '授权失败，请重试')
    }
    if (status?.status === 'expired') {
      throw new ApiError('oauth_expired', '授权已过期，请重试')
    }
    if (Date.now() >= deadline) {
      throw new ApiError('oauth_timeout', '授权超时，请重试')
    }
  }
}

interface DockSnapshot {
  open: boolean
  cards: ConnectorCard[]
  connections: Record<string, ConnectionView>
  loaded: boolean
  loading: boolean
  error: string | null
  query: string
  pendingId: string | null
  tokenFor: string | null
  token: string
}

const initialDockSnapshot: DockSnapshot = {
  open: false,
  cards: [],
  connections: {},
  loaded: false,
  loading: false,
  error: null,
  query: '',
  pendingId: null,
  tokenFor: null,
  token: '',
}

let dockSnapshot = initialDockSnapshot
const dockListeners = new Set<() => void>()
let dockRequest: Promise<void> | null = null
let dockDirty = false
let dockOAuthAbort: AbortController | null = null
let dockOAuthFlowId: string | null = null

function updateDock(patch: Partial<DockSnapshot>): void {
  dockSnapshot = { ...dockSnapshot, ...patch }
  for (const listener of dockListeners) listener()
}

function subscribeDock(listener: () => void): () => void {
  dockListeners.add(listener)
  return () => {
    dockListeners.delete(listener)
  }
}

function useDock(): DockSnapshot {
  return useSyncExternalStore(subscribeDock, () => dockSnapshot)
}

function refreshDock(): Promise<void> {
  if (dockRequest !== null) {
    dockDirty = true
    return dockRequest
  }
  updateDock({ loading: true, error: null })
  const task = (async () => {
    try {
      const [catalog, list] = await Promise.all([
        request<CatalogPayload>(`${ROUTE_PREFIX}/api/catalog`),
        request<ConnectionsPayload>(`${ROUTE_PREFIX}/api/connections`),
      ])
      updateDock({
        cards: catalog.value.cards,
        connections: Object.fromEntries(list.value.connections.map(item => [item.connectorId, item])),
        loaded: true,
        loading: false,
      })
    } catch (cause) {
      updateDock({ error: cause instanceof Error ? cause.message : String(cause), loading: false })
    }
  })()
  dockRequest = task
  void task.finally(() => {
    dockRequest = null
    if (dockDirty) {
      dockDirty = false
      void refreshDock()
    }
  })
  return task
}

function notifyConnectionsChanged(): void {
  window.dispatchEvent(new CustomEvent('dshc:connections-changed'))
}

function closeDock(): void {
  if (!dockSnapshot.open) return
  updateDock({ open: false, query: '', tokenFor: null, token: '', error: null })
}

function toggleDock(): void {
  if (dockSnapshot.open) closeDock()
  else updateDock({ open: true, error: null })
}

function enabledDockCards(state: DockSnapshot): ConnectorCard[] {
  return Object.values(state.connections)
    .filter(connection => connection.enabled && connection.authorized)
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(connection => state.cards.find(card => card.id === connection.connectorId))
    .filter((card): card is ConnectorCard => card !== undefined)
}

function openConnectorPanel(): void {
  closeDock()
  if (document.querySelector('.dshc-root') !== null) return
  const button = Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === '连接器')
  if (button === undefined) return
  const rect = button.getBoundingClientRect()
  const options: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent
    button.dispatchEvent(new EventType(type, options))
  }
}

async function toggleDockConnection(card: ConnectorCard, enabled: boolean): Promise<void> {
  updateDock({ pendingId: card.id, error: null })
  try {
    await request(`${ROUTE_PREFIX}/api/connections/${encodeURIComponent(card.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
    await refreshDock()
  } catch (cause) {
    updateDock({ error: cause instanceof Error ? cause.message : String(cause) })
  } finally {
    updateDock({ pendingId: null })
  }
}

function cancelDockOAuth(): void {
  const flowId = dockOAuthFlowId
  dockOAuthAbort?.abort()
  if (flowId !== null) {
    void request(`${ROUTE_PREFIX}/api/oauth/cancel`, {
      method: 'POST',
      body: JSON.stringify({ flowId }),
    }).catch(() => undefined)
  }
}

async function connectDock(card: ConnectorCard, token?: string): Promise<void> {
  updateDock({ pendingId: card.id, error: null })
  try {
    if (isOAuthCard(card)) {
      const controller = new AbortController()
      dockOAuthAbort = controller
      try {
        let connection = dockSnapshot.connections[card.id]
        if (connection === undefined) {
          const response = await request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections`, {
            method: 'POST',
            body: JSON.stringify({ connectorId: card.id }),
          })
          connection = response.value?.connection
          if (connection === undefined) throw new ApiError('invalid_response', '安装失败：宿主没有返回连接')
          updateDock({ connections: { ...dockSnapshot.connections, [card.id]: connection } })
        }
        if (!connection.authorized) {
          await authorizeConnector(card, {
            signal: controller.signal,
            onFlow: flow => {
              dockOAuthFlowId = flow.flowId
            },
          })
        }
      } finally {
        dockOAuthAbort = null
        dockOAuthFlowId = null
      }
    } else {
      await request(`${ROUTE_PREFIX}/api/connections`, {
        method: 'POST',
        body: JSON.stringify(token === undefined ? { connectorId: card.id } : { connectorId: card.id, token }),
      })
    }
    updateDock({ tokenFor: null, token: '' })
    await refreshDock()
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'oauth_cancelled') {
      void refreshDock()
    } else {
      updateDock({ error: cause instanceof Error ? cause.message : String(cause) })
    }
  } finally {
    updateDock({ pendingId: null })
  }
}

function ConnectorDock(): JSX.Element | null {
  const state = useDock()

  useEffect(() => {
    void refreshDock()
    const onChange = (): void => {
      void refreshDock()
    }
    window.addEventListener('dshc:connections-changed', onChange)
    return () => {
      window.removeEventListener('dshc:connections-changed', onChange)
      closeDock()
    }
  }, [])

  if (!state.loaded) return null
  const cards = enabledDockCards(state)
  if (cards.length === 0) return null
  const shown = cards.slice(0, 3)
  const extra = cards.length - shown.length
  const label = cards
    .map(card => `${card.name}${state.connections[card.id]?.error === undefined ? '' : '（连接失败）'}`)
    .join('、')
  const single = shown.length === 1 && extra === 0

  return (
    <button
      type="button"
      className={single ? 'dshc-dock dshc-dock-single' : 'dshc-dock'}
      data-dshc-dock="true"
      title={label}
      aria-label={`已启用 ${cards.length} 个连接器`}
      onClick={toggleDock}
    >
      {shown.map((card, index) => {
        const failed = state.connections[card.id]?.error !== undefined
        return (
          <span key={card.id} className="dshc-dock-icon" style={{ zIndex: shown.length - index }}>
            <ConnectorLogo card={card} size={18} />
            {failed && <span className="dshc-dock-dot" />}
          </span>
        )
      })}
      {extra > 0 && <span className="dshc-dock-more">+{extra}</span>}
    </button>
  )
}

function ConnectorPopover(): JSX.Element | null {
  const state = useDock()

  useEffect(() => {
    if (state.open) void refreshDock()
  }, [state.open])

  useEffect(() => {
    if (!state.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDock()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-dshc-dock],.dshc-dock-popover') === null) closeDock()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [state.open])

  if (!state.open) return null

  const keyword = state.query.trim().toLowerCase()
  const cards = state.cards
    .filter(card => keyword === ''
      || `${card.name} ${card.vendor ?? ''} ${card.summary} ${(card.tags ?? []).join(' ')}`.toLowerCase().includes(keyword))
    .sort((left, right) => {
      const leftConnected = state.connections[left.id] === undefined ? 1 : 0
      const rightConnected = state.connections[right.id] === undefined ? 1 : 0
      return leftConnected - rightConnected || left.name.localeCompare(right.name)
    })

  return (
    <div className="dshc-dock-popover" role="dialog" aria-label="连接器">
      <label className="dshc-dock-search">
        <IconSearch size={13} />
        <input
          autoFocus
          placeholder="搜索连接器"
          value={state.query}
          onChange={event => updateDock({ query: event.target.value })}
        />
      </label>
      <div className="dshc-dock-list">
        {!state.loaded
          ? <div className="dshc-dock-empty">{state.loading ? '正在加载连接器…' : '没有可用的连接器'}</div>
          : cards.length === 0
            ? <div className="dshc-dock-empty">没有匹配的连接器</div>
            : cards.map(card => {
                const connection = state.connections[card.id]
                const pending = state.pendingId === card.id
                const oauth = isOAuthCard(card)
                const needsToken = card.authMode === 'api-key' || card.authMode === 'bearer'
                const unsupported = (card.authMode === 'oauth2-pkce' && !oauth) || card.authMode === 'fields'
                return (
                  <div className="dshc-dock-item" key={card.id}>
                    <div className="dshc-dock-row">
                      <span className="dshc-dock-row-icon"><ConnectorLogo card={card} size={18} /></span>
                      <span className="dshc-dock-row-main">
                        <span className="dshc-dock-row-name">{card.name}</span>
                        {connection?.error !== undefined
                          ? <span className="dshc-dock-row-error">连接失败</span>
                          : connection !== undefined && !connection.authorized
                            ? <span className="dshc-dock-row-state">未授权</span>
                            : null}
                      </span>
                      {connection !== undefined && (connection.authorized || !oauth)
                        ? (
                            <button
                              type="button"
                              role="switch"
                              className="dshc-switch"
                              aria-checked={connection.enabled}
                              aria-label={connection.enabled ? `停用 ${card.name}` : `启用 ${card.name}`}
                              title={connection.enabled ? '停用' : '启用'}
                              disabled={pending}
                              onClick={() => { void toggleDockConnection(card, !connection.enabled) }}
                            />
                          )
                        : oauth
                          ? (
                              <button
                                type="button"
                                className="dshc-dock-connect"
                                onClick={() => {
                                  if (pending) cancelDockOAuth()
                                  else void connectDock(card)
                                }}
                              >
                                {pending ? '取消' : connection === undefined ? '安装' : '授权'}
                              </button>
                            )
                          : unsupported
                            ? <span className="dshc-dock-row-hint">未接入</span>
                            : (
                                <button
                                  type="button"
                                  className="dshc-dock-connect"
                                  disabled={pending}
                                  onClick={() => {
                                    if (needsToken) updateDock({ tokenFor: card.id, token: '' })
                                    else void connectDock(card)
                                  }}
                                >
                                  {pending ? '连接中…' : '连接'}
                                </button>
                              )}
                    </div>
                    {state.tokenFor === card.id && (
                      <div className="dshc-dock-token">
                        <input
                          type="password"
                          autoFocus
                          autoComplete="off"
                          placeholder={card.authLabel ?? '粘贴令牌'}
                          value={state.token}
                          onChange={event => updateDock({ token: event.target.value })}
                          onKeyDown={event => {
                            if (event.key === 'Enter' && !pending && state.token.trim() !== '') {
                              event.preventDefault()
                              void connectDock(card, state.token)
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="dshc-dock-connect"
                          disabled={pending || state.token.trim() === ''}
                          onClick={() => { void connectDock(card, state.token) }}
                        >
                          {pending ? '连接中…' : '连接'}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
      </div>
      {state.error !== null && <div className="dshc-dock-error">{state.error}</div>}
      <button type="button" className="dshc-dock-manage" onClick={openConnectorPanel}>
        <IconLink size={13} />
        管理连接器
      </button>
    </div>
  )
}

function Panel({ startTrial }: PanelProps): JSX.Element {
  const [cards, setCards] = useState<ConnectorCard[]>([])
  const [connections, setConnections] = useState<Record<string, ConnectionView>>({})
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部')
  const [loading, setLoading] = useState(false)
  const [dialogCard, setDialogCard] = useState<ConnectorCard | null>(null)
  const [dialogInstall, setDialogInstall] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [togglePending, setTogglePending] = useState<string | null>(null)
  const [oauthFlow, setOAuthFlow] = useState<(OAuthFlowInfo & { connectorId: string }) | null>(null)
  const oauthAbortRef = useRef<AbortController | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [deleteCard, setDeleteCard] = useState<ConnectorCard | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const refreshConnections = (): void => {
    void (async () => {
      try {
        const list = await request<ConnectionsPayload>(`${ROUTE_PREFIX}/api/connections`)
        setConnections(Object.fromEntries(list.value.connections.map(item => [item.connectorId, item])))
      } catch {
        // 保留当前状态，下一次刷新再试
      }
    })()
  }

  const refreshSoon = (): void => {
    for (const delay of [1200, 3200, 8000, 15000]) {
      window.setTimeout(refreshConnections, delay)
    }
  }

  const load = (): void => {
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const [catalog, list] = await Promise.all([
          request<CatalogPayload>(`${ROUTE_PREFIX}/api/catalog`),
          request<ConnectionsPayload>(`${ROUTE_PREFIX}/api/connections`),
        ])
        setCards(catalog.value.cards)
        const merged = Object.fromEntries(list.value.connections.map(item => [item.connectorId, item]))
        setConnections(merged)
        if (Object.values(merged).some(item => item.authorized && item.error === undefined && item.tools.length === 0)) {
          refreshSoon()
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    })()
  }

  useEffect(load, [])

  const categories = useMemo(() => ['全部', ...Array.from(new Set(cards.map(card => card.category)))], [cards])

  useEffect(() => {
    if (!categories.includes(category)) setCategory('全部')
  }, [categories, category])

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return cards.filter(card => {
      if (category !== '全部' && card.category !== category) return false
      if (keyword.length === 0) return true
      return `${card.name} ${card.vendor ?? ''} ${card.summary} ${(card.tags ?? []).join(' ')}`.toLowerCase().includes(keyword)
    })
  }, [cards, category, query])

  const openDialog = (card: ConnectorCard, install = false): void => {
    setDialogError(null)
    setDialogInstall(install)
    setDialogCard(card)
  }

  const applyConnection = (connection: ConnectionView): void => {
    setConnections(previous => ({ ...previous, [connection.connectorId]: connection }))
    notifyConnectionsChanged()
  }

  const connect = (card: ConnectorCard, token?: string, surface: 'dialog' | 'page' = 'dialog'): void => {
    setPending(card.id)
    if (surface === 'dialog') setDialogError(null)
    else setError(null)
    void (async () => {
      try {
        const response = await request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections`, {
          method: 'POST',
          body: JSON.stringify(token === undefined ? { connectorId: card.id } : { connectorId: card.id, token }),
        })
        const connection = response.value?.connection
        if (connection !== undefined) {
          applyConnection(connection)
          if (connection.authorized && connection.error === undefined && connection.tools.length === 0) refreshSoon()
          setDialogInstall(false)
        }
        setDialogError(null)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (surface === 'dialog') setDialogError(message)
        else setError(message)
      } finally {
        setPending(null)
      }
    })()
  }

  const installConnector = async (card: ConnectorCard): Promise<ConnectionView> => {
    const response = await request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections`, {
      method: 'POST',
      body: JSON.stringify({ connectorId: card.id }),
    })
    const connection = response.value?.connection
    if (connection === undefined) throw new ApiError('invalid_response', '安装失败：宿主没有返回连接')
    return connection
  }

  const runOAuth = (card: ConnectorCard, installFirst: boolean, surface: 'dialog' | 'page' = 'dialog'): void => {
    const controller = new AbortController()
    oauthAbortRef.current = controller
    setPending(card.id)
    if (surface === 'dialog') setDialogError(null)
    else setError(null)
    void (async () => {
      try {
        let connection = connections[card.id]
        if (installFirst || connection === undefined) {
          connection = await installConnector(card)
          applyConnection(connection)
          setDialogInstall(false)
        }
        if (!connection.authorized) {
          const authorized = await authorizeConnector(card, {
            signal: controller.signal,
            onFlow: flow => {
              setOAuthFlow({ ...flow, connectorId: card.id })
              if (!flow.opened) setDialogCard(card)
            },
          })
          applyConnection(authorized)
          if (authorized.authorized && authorized.error === undefined && authorized.tools.length === 0) refreshSoon()
          setDialogInstall(false)
          setDialogError(null)
        }
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.code === 'oauth_cancelled')) {
          const message = cause instanceof Error ? cause.message : String(cause)
          if (surface === 'dialog') setDialogError(message)
          else setError(message)
        }
        refreshConnections()
      } finally {
        setPending(null)
        setOAuthFlow(null)
        oauthAbortRef.current = null
      }
    })()
  }

  const cancelAuthorize = (): void => {
    const flow = oauthFlow
    oauthAbortRef.current?.abort()
    if (flow !== null) {
      void request(`${ROUTE_PREFIX}/api/oauth/cancel`, {
        method: 'POST',
        body: JSON.stringify({ flowId: flow.flowId }),
      }).catch(() => undefined)
    }
    setDialogError(null)
  }

  const revoke = (card: ConnectorCard, surface: 'dialog' | 'page' = 'dialog'): void => {
    setPending(card.id)
    if (surface === 'dialog') setDialogError(null)
    else setError(null)
    void (async () => {
      try {
        const response = await request<ConnectResponse>(
          `${ROUTE_PREFIX}/api/connections/${encodeURIComponent(card.id)}/oauth`,
          { method: 'DELETE' },
        )
        const connection = response.value?.connection
        if (connection !== undefined) applyConnection(connection)
        else refreshConnections()
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (surface === 'dialog') setDialogError(message)
        else setError(message)
      } finally {
        setPending(null)
      }
    })()
  }

  const disconnect = (card: ConnectorCard): void => {
    setPending(card.id)
    setError(null)
    void (async () => {
      try {
        await request(`${ROUTE_PREFIX}/api/connections/${encodeURIComponent(card.id)}`, { method: 'DELETE' })
        setConnections(previous => {
          const next = { ...previous }
          delete next[card.id]
          return next
        })
        notifyConnectionsChanged()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setPending(null)
      }
    })()
  }

  const onImported = (imported: ConnectorCard[]): void => {
    setCards(previous => {
      const existing = new Set(previous.map(card => card.id))
      return [...previous, ...imported.filter(card => !existing.has(card.id))]
    })
    setCategory('自定义')
    notifyConnectionsChanged()
  }

  const removeCustom = (card: ConnectorCard): void => {
    setPending(card.id)
    setDeleteError(null)
    void (async () => {
      try {
        await request(`${ROUTE_PREFIX}/api/custom-connectors/${encodeURIComponent(card.id)}`, { method: 'DELETE' })
        setCards(previous => previous.filter(item => item.id !== card.id))
        setConnections(previous => {
          const next = { ...previous }
          delete next[card.id]
          return next
        })
        setDeleteCard(null)
        setDialogCard(null)
        notifyConnectionsChanged()
      } catch (cause) {
        setDeleteError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setPending(null)
      }
    })()
  }

  const toggleConnection = (card: ConnectorCard, enabled: boolean): void => {
    setTogglePending(card.id)
    setError(null)
    void (async () => {
      try {
        const response = await request<ConnectResponse>(
          `${ROUTE_PREFIX}/api/connections/${encodeURIComponent(card.id)}`,
          { method: 'PATCH', body: JSON.stringify({ enabled }) },
        )
        const connection = response.value?.connection
        if (connection !== undefined) {
          setConnections(previous => ({ ...previous, [connection.connectorId]: connection }))
          notifyConnectionsChanged()
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        refreshConnections()
      } finally {
        setTogglePending(null)
      }
    })()
  }

  const startTrialFor = (card: ConnectorCard): void => {
    setError(null)
    try {
      startTrial(promptForNextExample(card))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const tryExample = (card: ConnectorCard, example: string): void => {
    setDialogError(null)
    try {
      startTrial(promptForExample(card, example))
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const isAuthorizing = (card: ConnectorCard): boolean =>
    pending === card.id
    && (oauthFlow?.connectorId === card.id
      || (isOAuthCard(card) && connections[card.id]?.authorized === false))

  return (
    <div className="dshc-root">
      <div className="dshc-inner">
        <header className="dshc-header">
          <h1>连接器</h1>
          <button type="button" className="dshc-btn dshc-btn-primary dshc-create" onClick={() => setCustomOpen(true)}>
            <IconPlus size={13} />
            自定义连接器
          </button>
        </header>

        <nav className="dshc-tabs">
          {categories.map(item => (
            <button
              key={item}
              type="button"
              className={item === category ? 'dshc-tab dshc-tab-active' : 'dshc-tab'}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </nav>

        <label className="dshc-search">
          <IconSearch size={14} />
          <input
            placeholder="搜索连接器"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </label>

        {error !== null && <div className="dshc-error">{error}</div>}

        {visible.length === 0
          ? <div className="dshc-empty">{loading ? '正在加载连接器…' : '没有匹配的连接器'}</div>
          : (
            <div className="dshc-grid">
              {visible.map(card => (
                <ConnectorCardView
                  key={card.id}
                  card={card}
                  connection={connections[card.id]}
                  togglePending={togglePending === card.id}
                  authorizing={isAuthorizing(card)}
                  installing={pending === card.id}
                  onOpen={() => openDialog(card, false)}
                  onInstall={() => {
                    if (isOAuthCard(card)) {
                      runOAuth(card, true, 'page')
                      return
                    }
                    if (card.authMode === 'none') {
                      connect(card, undefined, 'page')
                      return
                    }
                    openDialog(card, true)
                  }}
                  onAuthorize={() => runOAuth(card, false, 'page')}
                  onCancelAuthorize={cancelAuthorize}
                  onRevoke={card.authMode === 'oauth2-pkce'
                    ? () => revoke(card, 'page')
                    : undefined}
                  onTrial={() => startTrialFor(card)}
                  onToggle={enabled => toggleConnection(card, enabled)}
                  onDisconnect={() => disconnect(card)}
                  onDelete={card.source === 'custom'
                    ? () => {
                        setDeleteError(null)
                        setDeleteCard(card)
                      }
                    : undefined}
                />
              ))}
            </div>
          )}
      </div>

      {dialogCard !== null && (
        <ConnectorDialog
          card={dialogCard}
          connection={connections[dialogCard.id]}
          pending={pending === dialogCard.id}
          toggling={togglePending === dialogCard.id}
          authorizing={isAuthorizing(dialogCard)}
          authorizeLink={oauthFlow?.connectorId === dialogCard.id && !oauthFlow.opened ? oauthFlow.authorizeUrl : null}
          installOpen={dialogInstall}
          error={dialogError}
          onClose={() => {
            if (pending === null) {
              setDialogCard(null)
              setDialogInstall(false)
              setDialogError(null)
            }
          }}
          onBeginInstall={() => {
            setDialogError(null)
            setDialogInstall(true)
          }}
          onCancelInstall={() => {
            setDialogInstall(false)
            setDialogError(null)
          }}
          onConnect={token => connect(dialogCard, token)}
          onInstallOAuth={() => runOAuth(dialogCard, true)}
          onAuthorize={() => runOAuth(dialogCard, false)}
          onCancelAuthorize={cancelAuthorize}
          onTryExample={example => tryExample(dialogCard, example)}
          onRevoke={() => revoke(dialogCard)}
          onDisconnect={() => disconnect(dialogCard)}
          onToggle={enabled => toggleConnection(dialogCard, enabled)}
          onDelete={dialogCard.source === 'custom'
            ? () => {
                setDeleteError(null)
                setDeleteCard(dialogCard)
              }
            : undefined}
        />
      )}

      {customOpen && (
        <CustomConnectorDialog
          onClose={() => setCustomOpen(false)}
          onImported={onImported}
        />
      )}

      {deleteCard !== null && (
        <DeleteCustomDialog
          card={deleteCard}
          pending={pending === deleteCard.id}
          error={deleteError}
          onClose={() => {
            if (pending === null) {
              setDeleteCard(null)
              setDeleteError(null)
            }
          }}
          onConfirm={() => removeCustom(deleteCard)}
        />
      )}
    </div>
  )
}

interface CardTip {
  text: string
  left: number
  top: number
}

interface CardProps {
  card: ConnectorCard
  connection?: ConnectionView
  togglePending: boolean
  authorizing: boolean
  installing: boolean
  onOpen: () => void
  onInstall: () => void
  onAuthorize: () => void
  onCancelAuthorize: () => void
  onRevoke?: () => void
  onTrial: () => void
  onToggle: (enabled: boolean) => void
  onDisconnect: () => void
  onDelete?: () => void
}

function ConnectorCardView({ card, connection, togglePending, authorizing, installing, onOpen, onInstall, onAuthorize, onCancelAuthorize, onRevoke, onTrial, onToggle, onDisconnect, onDelete }: CardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [tip, setTip] = useState<CardTip | null>(null)
  const menuRef = useRef<HTMLSpanElement>(null)
  const connected = connection !== undefined && connection.authorized && connection.enabled && connection.error === undefined
  const unauthorized = connection !== undefined && !connection.authorized
  const toolCount = connection?.tools.length ?? 0
  const error = connection?.error
  const enabled = connection?.enabled === true

  useEffect(() => {
    if (tip === null) return
    const close = (): void => setTip(null)
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [tip])

  const showTip = (element: HTMLElement): void => {
    // line-clamp 下只有 scrollHeight 超出才代表文本被截断
    if (element.scrollHeight <= element.clientHeight + 1) return
    const rect = element.getBoundingClientRect()
    const width = Math.min(360, window.innerWidth - 32)
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))
    setTip({ text: card.summary, left, top: rect.bottom + 8 })
  }

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const actionClass = error !== undefined
    ? 'dshc-card-action dshc-card-action-error'
    : connection === undefined
      ? 'dshc-card-action dshc-card-action-connect'
      : enabled
        ? 'dshc-card-action dshc-card-action-connected'
        : 'dshc-card-action dshc-card-action-disabled'
  const actionText = error ?? (connection === undefined
    ? '查看详情'
    : unauthorized
      ? '未授权'
      : !enabled
        ? '已停用'
        : toolCount > 0
          ? `已连接 · ${toolCount} 个工具\n${connection.tools.join('\n')}`
          : '已连接 · 注册中')
  const stateLabel = error !== undefined
    ? '，连接失败'
    : connection === undefined
      ? ''
      : unauthorized
        ? '，未授权'
        : !enabled
          ? '，已停用'
          : toolCount > 0 ? `，已连接，${toolCount} 个工具` : '，已连接，正在注册工具'

  return (
    <>
      <article
        className={menuOpen ? 'dshc-card dshc-card-menu-open' : 'dshc-card'}
      role="button"
      tabIndex={0}
      aria-label={`查看 ${card.name}${stateLabel}`}
      onClick={() => {
        if (menuOpen) {
          setMenuOpen(false)
          return
        }
        onOpen()
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="dshc-card-top">
        <span className="dshc-avatar"><ConnectorLogo card={card} /></span>
        <div className="dshc-card-title">
          <strong>{card.name}</strong>
          <span>{card.vendor ?? card.servers[0]?.transport}</span>
        </div>
      </div>
      <p
        className="dshc-summary"
        onMouseEnter={event => showTip(event.currentTarget)}
        onMouseLeave={() => setTip(null)}
        onPointerLeave={() => setTip(null)}
      >
        {card.summary}
      </p>
      <div className="dshc-card-foot">
        <span className="dshc-badge">{card.category}</span>
        {connection === undefined ? (
          <button
            type="button"
            className={installing ? `${actionClass} dshc-card-action-loading` : actionClass}
            title={installing ? '安装中…' : '安装'}
            aria-label={installing ? `正在安装 ${card.name}` : `安装 ${card.name}`}
            disabled={installing}
            onClick={event => {
              event.stopPropagation()
              onInstall()
            }}
          >
            {installing ? <span className="dshc-spinner" aria-hidden /> : <IconPlus size={16} />}
          </button>
        ) : unauthorized ? (
          <span className="dshc-card-auth-actions">
            <button
              type="button"
              className="dshc-card-auth"
              aria-label={authorizing ? `取消授权 ${card.name}` : `授权 ${card.name}`}
              onClick={event => {
                event.stopPropagation()
                if (authorizing) onCancelAuthorize()
                else onAuthorize()
              }}
            >
              {authorizing && <span className="dshc-spinner dshc-spinner-inline" aria-hidden />}
              {authorizing ? '取消授权' : '授权'}
            </button>            <span className="dshc-card-more-wrap" ref={menuRef}>
              <button
                type="button"
                className="dshc-card-more"
                aria-label={`${card.name} 更多操作`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={event => {
                  event.stopPropagation()
                  setMenuOpen(current => !current)
                }}
              >
                <IconMore size={16} />
              </button>
              {menuOpen && (
                <span className="dshc-menu" role="menu" onClick={event => event.stopPropagation()}>
                  {onDelete !== undefined ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="dshc-menu-item dshc-menu-item-danger"
                      onClick={() => {
                        setMenuOpen(false)
                        onDelete()
                      }}
                    >
                      <IconTrash size={14} />
                      删除连接器
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      className="dshc-menu-item dshc-menu-item-danger"
                      onClick={() => {
                        setMenuOpen(false)
                        onDisconnect()
                      }}
                    >
                      <IconTrash size={14} />
                      删除
                    </button>
                  )}
                </span>
              )}
            </span>
          </span>
        ) : (
          <span className="dshc-card-actions">
            <span className={`${actionClass} dshc-card-status`} title={actionText} aria-hidden>
              {error !== undefined
                ? <IconAlert size={16} />
                : <IconCheck size={16} />}
            </span>
            <span className="dshc-card-controls">
              <span className="dshc-card-more-wrap" ref={menuRef}>
                <button
                  type="button"
                  className="dshc-card-more"
                  aria-label={`${card.name} 更多操作`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={event => {
                    event.stopPropagation()
                    setMenuOpen(current => !current)
                  }}
                >
                  <IconMore size={16} />
                </button>
                {menuOpen && (
                  <span className="dshc-menu" role="menu" onClick={event => event.stopPropagation()}>
                    <button
                      type="button"
                      role="menuitem"
                      className="dshc-menu-item"
                      disabled={!connected || toolCount === 0}
                      onClick={() => {
                        setMenuOpen(false)
                        onTrial()
                      }}
                    >
                      <IconPlay size={14} />
                      去试试
                    </button>
                    {onRevoke !== undefined && (
                      <button
                        type="button"
                        role="menuitem"
                        className="dshc-menu-item"
                        onClick={() => {
                          setMenuOpen(false)
                          onRevoke()
                        }}
                      >
                        <IconLink size={14} />
                        取消授权
                      </button>
                    )}
                    {onDelete !== undefined ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="dshc-menu-item dshc-menu-item-danger"
                        onClick={() => {
                          setMenuOpen(false)
                          onDelete()
                        }}
                      >
                        <IconTrash size={14} />
                        删除连接器
                      </button>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        className="dshc-menu-item dshc-menu-item-danger"
                        onClick={() => {
                          setMenuOpen(false)
                          onDisconnect()
                        }}
                      >
                        <IconTrash size={14} />
                        删除
                      </button>
                    )}
                  </span>
                )}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={enabled ? `停用 ${card.name}` : `启用 ${card.name}`}
                title={enabled ? '停用' : '启用'}
                className="dshc-switch"
                disabled={togglePending}
                onClick={event => {
                  event.stopPropagation()
                  onToggle(!enabled)
                }}
              />
            </span>
          </span>
        )}
      </div>
      </article>
      {tip !== null && createPortal(
        <div className="dshc-card-tip" style={{ left: tip.left, top: tip.top }}>
          {tip.text}
        </div>,
        document.body,
      )}
    </>
  )
}

interface ConnectorDialogProps {
  card: ConnectorCard
  connection?: ConnectionView
  pending: boolean
  toggling: boolean
  authorizing: boolean
  authorizeLink: string | null
  installOpen: boolean
  error: string | null
  onClose: () => void
  onBeginInstall: () => void
  onCancelInstall: () => void
  onConnect: (token?: string) => void
  onInstallOAuth: () => void
  onAuthorize: () => void
  onCancelAuthorize: () => void
  onTryExample: (example: string) => void
  onRevoke: () => void
  onDisconnect: () => void
  onToggle: (enabled: boolean) => void
  onDelete?: () => void
}

function ConnectorDialog({ card, connection, pending, toggling, authorizing, authorizeLink, installOpen, error, onClose, onBeginInstall, onCancelInstall, onConnect, onInstallOAuth, onAuthorize, onCancelAuthorize, onTryExample, onRevoke, onDisconnect, onToggle, onDelete }: ConnectorDialogProps): JSX.Element {
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState<number | null>(null)
  const [copyFailed, setCopyFailed] = useState<number | null>(null)
  const [showAllTools, setShowAllTools] = useState(false)
  const [expandedTool, setExpandedTool] = useState<string | null>(null)
  const [exampleTip, setExampleTip] = useState<{
    index: number
    action: 'copy' | 'try'
    left: number
    top: number
    above: boolean
  } | null>(null)
  const needsToken = card.authMode === 'api-key' || card.authMode === 'bearer'
  const oauth = isOAuthCard(card)
  const unsupported = (card.authMode === 'oauth2-pkce' && !oauth) || card.authMode === 'fields'
  const unauthorized = connection !== undefined && !connection.authorized
  const disabled = connection !== undefined && connection.authorized && !connection.enabled
  const connected = connection !== undefined && connection.authorized && connection.enabled && connection.error === undefined
  const toolDetails: ToolInfo[] = connection?.toolDetails ?? (connection?.tools ?? []).map(name => ({ name }))
  const canTry = connected && toolDetails.length > 0
  const visibleTools = showAllTools ? toolDetails : toolDetails.slice(0, 4)
  const examples = card.examples ?? []
  const showingInstall = installOpen && !unsupported && connection === undefined
  const failedWithToken = needsToken && connection !== undefined && connection.error !== undefined
  const tokenEntry = needsToken && (showingInstall || failedWithToken)
  const busy = pending || toggling
  const removeLabel = onDelete === undefined ? '删除' : '断开'
  const removingLabel = onDelete === undefined ? '删除中…' : '断开中…'
  const removeClass = onDelete === undefined
    ? 'dshc-btn dshc-btn-md dshc-btn-outline dshc-btn-danger'
    : 'dshc-btn dshc-btn-md dshc-btn-outline'

  useEffect(() => {
    setToken('')
    setCopied(null)
    setCopyFailed(null)
    setShowAllTools(false)
    setExpandedTool(null)
  }, [card.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const copyExample = (index: number, text: string): void => {
    void (async () => {
      try {
        await writeClipboard(text)
        setCopied(index)
        setCopyFailed(null)
        window.setTimeout(() => setCopied(current => (current === index ? null : current)), 1500)
      } catch {
        setCopyFailed(index)
        setCopied(null)
        window.setTimeout(() => setCopyFailed(current => (current === index ? null : current)), 2000)
      }
    })()
  }

  const showExampleTip = (element: HTMLElement, index: number, action: 'copy' | 'try'): void => {
    const rect = element.getBoundingClientRect()
    const above = rect.bottom + 34 > window.innerHeight
    setExampleTip({
      index,
      action,
      left: rect.left + rect.width / 2,
      top: above ? rect.top - 6 : rect.bottom + 6,
      above,
    })
  }

  const exampleTipText = exampleTip === null
    ? null
    : exampleTip.action === 'try'
      ? '去试试'
      : copied === exampleTip.index
        ? '已复制'
        : copyFailed === exampleTip.index
          ? '复制失败'
          : '复制'

  const statusText = unsupported
    ? '授权方式未接入'
    : connection === undefined
      ? '未连接'
      : unauthorized
        ? (authorizing ? '授权中' : '未授权')
        : disabled
          ? '已停用'
          : connected
            ? '已连接'
            : '连接失败'
  const statusClass = unsupported || connection === undefined || unauthorized || disabled
    ? 'dshc-status-pill'
    : connected
      ? 'dshc-status-pill dshc-status-pill-connected'
      : 'dshc-status-pill dshc-status-pill-error'

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="dshc-dialog dshc-dialog-detail" role="dialog" aria-modal="true" aria-label={card.name}>
        <div className="dshc-dialog-head dshc-dialog-head-detail">
          <span className="dshc-avatar dshc-dialog-avatar dshc-dialog-avatar-lg"><ConnectorLogo card={card} /></span>
          <div className="dshc-dialog-title">
            <h2>{card.name}</h2>
            <span>{[card.vendor, card.category].filter(Boolean).join(' · ')}</span>
          </div>
          <span className={`${statusClass} dshc-dialog-status-pill`}>{statusText}</span>
          <button type="button" className="dshc-icon-btn" aria-label="关闭" disabled={busy} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        <div className="dshc-dialog-content">
          <p className="dshc-dialog-body">{card.description ?? card.summary}</p>
          {connection?.error !== undefined && <p className="dshc-dialog-error">{connection.error}</p>}

          {unsupported && (
            <p className="dshc-dialog-hint">{card.name} 使用 OAuth 授权，授权流程尚未接入。</p>
          )}
          {needsToken && tokenEntry && (
            <label className="dshc-field">
              <span>{card.authLabel ?? '访问令牌'}</span>
              <input
                type="password"
                autoFocus
                autoComplete="off"
                placeholder={failedWithToken ? '粘贴新令牌' : '粘贴令牌'}
                value={token}
                onChange={event => setToken(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !pending && token.trim() !== '') {
                    event.preventDefault()
                    onConnect(token)
                  }
                }}
              />
            </label>
          )}
          {needsToken && tokenEntry && card.authHelpUrl !== undefined && (
            <p className="dshc-dialog-hint">
              <a className="dshc-link" href={card.authHelpUrl} target="_blank" rel="noreferrer">
                {card.authHelpLabel ?? '创建访问令牌'}
              </a>
              {card.authHelpHint !== undefined && <span>　{card.authHelpHint}</span>}
            </p>
          )}
          {oauth && showingInstall && (
            <p className="dshc-dialog-hint">安装后会自动打开默认浏览器完成 GitLab 授权。</p>
          )}
          {unauthorized && (
            <p className="dshc-dialog-hint">
              {authorizing
                ? '已打开授权页，完成授权后会自动同步。'
                : '已安装，点击授权后在浏览器完成 GitLab 登录。'}
            </p>
          )}
          {authorizeLink !== null && authorizing && (
            <p className="dshc-dialog-hint">
              没有自动打开浏览器？
              <a className="dshc-link" href={authorizeLink} target="_blank" rel="noreferrer">点此授权</a>
            </p>
          )}
          {showingInstall && !needsToken && !oauth && (
            <p className="dshc-dialog-hint">安装后会接入 MCP 服务，工具会出现在 Agent 中。</p>
          )}
          {error !== null && <p className="dshc-dialog-error">{error}</p>}

          {toolDetails.length > 0 && (
            <section className="dshc-tools">
              <div className="dshc-tools-head">
                <h3>可用工具</h3>
                <span className="dshc-tools-count">{toolDetails.length}</span>
              </div>
              <div className="dshc-tool-list">
                {visibleTools.map(tool => {
                  const expanded = expandedTool === tool.name
                  const canExpand = tool.description !== undefined
                    && (tool.description.length > 120 || tool.description.includes('\n'))
                  return (
                    <div className="dshc-tool" key={tool.name}>
                      <div className="dshc-tool-head">
                        <code>{shortToolName(tool.name, connection?.serverName)}</code>
                        {canExpand && (
                          <button
                            type="button"
                            className="dshc-tool-expand"
                            aria-label={expanded ? '收起描述' : '展开描述'}
                            aria-expanded={expanded}
                            title={expanded ? '收起描述' : '展开描述'}
                            onClick={() => setExpandedTool(expanded ? null : tool.name)}
                          >
                            <IconChevronDown
                              size={14}
                              className={expanded ? 'dshc-tool-chevron dshc-tool-chevron-expanded' : 'dshc-tool-chevron'}
                            />
                          </button>
                        )}
                      </div>
                      {tool.description !== undefined && (
                        <p className={expanded ? 'dshc-tool-desc-expanded' : undefined}>{tool.description}</p>
                      )}
                    </div>
                  )
                })}
              </div>
              {toolDetails.length > 4 && (
                <button
                  type="button"
                  className="dshc-tools-toggle"
                  onClick={() => setShowAllTools(current => !current)}
                >
                  {showAllTools ? '收起' : `展开全部 ${toolDetails.length} 个`}
                </button>
              )}
            </section>
          )}
          {disabled && <p className="dshc-dialog-hint">已停用，启用后会重新注册工具。</p>}
          {connected && toolDetails.length === 0 && <p className="dshc-dialog-hint">正在注册工具…</p>}

          {examples.length > 0 ? (
            <section className="dshc-examples">
              <h3>试试这样用</h3>
              <div className="dshc-example-list">
                {examples.map((example, index) => (
                  <div className="dshc-example" key={example}>
                    <span className="dshc-example-text">{example}</span>
                    <span className="dshc-example-actions">
                      <button
                        type="button"
                        className={copied === index
                          ? 'dshc-example-action dshc-example-action-success'
                          : copyFailed === index
                            ? 'dshc-example-action dshc-example-action-error'
                            : 'dshc-example-action'}
                        aria-label={`复制示例：${example}`}
                        onMouseEnter={event => showExampleTip(event.currentTarget, index, 'copy')}
                        onMouseLeave={() => setExampleTip(null)}
                        onFocus={event => showExampleTip(event.currentTarget, index, 'copy')}
                        onBlur={() => setExampleTip(null)}
                        onClick={() => copyExample(index, promptForExample(card, example))}
                      >
                        {copied === index
                          ? <IconCheck size={14} />
                          : copyFailed === index
                            ? <IconAlert size={14} />
                            : <IconCopy size={14} />}
                      </button>
                      <button
                        type="button"
                        className="dshc-example-action"
                        aria-label={`去试试：${example}`}
                        disabled={!canTry}
                        onMouseEnter={event => showExampleTip(event.currentTarget, index, 'try')}
                        onMouseLeave={() => setExampleTip(null)}
                        onFocus={event => showExampleTip(event.currentTarget, index, 'try')}
                        onBlur={() => setExampleTip(null)}
                        onClick={() => onTryExample(example)}
                      >
                        <IconPlay size={14} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <p className="dshc-dialog-hint">这个自定义连接器没有预置示例；连接后可在 Agent 中直接调用它的工具。</p>
          )}
        </div>

        <div className="dshc-dialog-actions">
          {onDelete !== undefined && (
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost dshc-btn-danger" disabled={busy} onClick={onDelete}>
              删除连接器
            </button>
          )}
          {oauth && connection?.authorized === true && (
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost" disabled={busy} onClick={onRevoke}>
              取消授权
            </button>
          )}
          <span className="dshc-dialog-actions-right">
            {unsupported && (
              <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" disabled={busy} onClick={onClose}>
                关闭
              </button>
            )}
            {!unsupported && unauthorized && (
              authorizing ? (
                <>
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onCancelAuthorize}>
                    取消授权
                  </button>
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled>
                    <span className="dshc-spinner" aria-hidden />
                    授权中…
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className={removeClass} disabled={busy} onClick={onDisconnect}>
                    {removeLabel}
                  </button>
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled={busy} onClick={onAuthorize}>
                    授权 GitLab
                  </button>
                </>
              )
            )}
            {!unsupported && disabled && (
              <>
                <button type="button" className={removeClass} disabled={busy} onClick={onDisconnect}>
                  {removeLabel}
                </button>
                <button
                  type="button"
                  className="dshc-btn dshc-btn-md dshc-btn-primary"
                  disabled={busy}
                  onClick={() => onToggle(true)}
                >
                  {toggling ? '启用中…' : '启用'}
                </button>
              </>
            )}
            {!unsupported && connected && (
              <>
                <button type="button" className={removeClass} disabled={busy} onClick={onDisconnect}>
                  {pending ? removingLabel : removeLabel}
                </button>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled={busy} onClick={onClose}>
                  完成
                </button>
              </>
            )}
            {!unsupported && connection !== undefined && connection.authorized && !connected && !disabled && (
              <>
                <button type="button" className={removeClass} disabled={busy} onClick={onDisconnect}>
                  {removeLabel}
                </button>
                {oauth ? (
                  <button
                    type="button"
                    className="dshc-btn dshc-btn-md dshc-btn-primary"
                    disabled={busy}
                    onClick={onAuthorize}
                  >
                    {pending ? '授权中…' : '重新授权'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="dshc-btn dshc-btn-md dshc-btn-primary"
                    disabled={busy || (needsToken && token.trim() === '')}
                    onClick={() => onConnect(needsToken ? token : undefined)}
                  >
                    {pending ? (needsToken ? '连接中…' : '重试中…') : (needsToken ? '重新连接' : '重试')}
                  </button>
                )}
              </>
            )}
            {!unsupported && connection === undefined && showingInstall && (
              <>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" disabled={busy} onClick={onCancelInstall}>
                  取消
                </button>
                {oauth ? (
                  <button
                    type="button"
                    className="dshc-btn dshc-btn-md dshc-btn-primary"
                    disabled={busy}
                    onClick={onInstallOAuth}
                  >
                    {pending ? '安装中…' : '安装'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="dshc-btn dshc-btn-md dshc-btn-primary"
                    disabled={busy || (needsToken && token.trim() === '')}
                    onClick={() => onConnect(needsToken ? token : undefined)}
                  >
                    {pending ? (needsToken ? '连接中…' : '安装中…') : (needsToken ? '连接' : '安装')}
                  </button>
                )}
              </>
            )}
            {!unsupported && connection === undefined && !showingInstall && (
              <>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" disabled={busy} onClick={onClose}>
                  关闭
                </button>
                <button
                  type="button"
                  className="dshc-btn dshc-btn-md dshc-btn-primary"
                  disabled={busy}
                  onClick={onBeginInstall}
                >
                  安装
                </button>
              </>
            )}
          </span>
        </div>
      </div>
      {exampleTip !== null && exampleTipText !== null && createPortal(
        <div
          className={exampleTip.above
            ? 'dshc-card-tip dshc-action-tip dshc-action-tip-above'
            : 'dshc-card-tip dshc-action-tip'}
          style={{ left: exampleTip.left, top: exampleTip.top }}
        >
          {exampleTipText}
        </div>,
        document.body,
      )}
    </div>
  )
}

interface CustomDialogProps {
  onClose: () => void
  onImported: (connectors: ConnectorCard[]) => void
}

function CustomConnectorDialog({ onClose, onImported }: CustomDialogProps): JSX.Element {
  const [json, setJson] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [privateWarning, setPrivateWarning] = useState(false)
  const [privateConfirmed, setPrivateConfirmed] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pending])

  const submit = (): void => {
    setPending(true)
    setError(null)
    void (async () => {
      try {
        const response = await request<CustomConnectorsPayload>(`${ROUTE_PREFIX}/api/custom-connectors`, {
          method: 'POST',
          body: JSON.stringify({ json, allowPrivate: privateWarning }),
        })
        onImported(response.value.connectors)
        onClose()
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === 'private_url_confirmation') {
          setPrivateWarning(true)
          setPrivateConfirmed(false)
          setError(cause.message)
        } else {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !pending) onClose()
      }}
    >
      <form
        className="dshc-dialog dshc-dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label="自定义连接器"
        onSubmit={event => {
          event.preventDefault()
          if (!pending && json.trim() !== '' && (!privateWarning || privateConfirmed)) submit()
        }}
      >
        <div className="dshc-dialog-head">
          <h2>自定义连接器</h2>
          <button type="button" className="dshc-icon-btn" aria-label="关闭" disabled={pending} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          <p className="dshc-dialog-body">粘贴 mcpServers JSON，支持 Streamable HTTP 与 stdio 两类 MCP Server。</p>
          <label className="dshc-field">
            <span>mcpServers JSON</span>
            <textarea
              autoFocus
              spellCheck={false}
              placeholder={MCP_SERVERS_PLACEHOLDER}
              value={json}
              onChange={event => {
                setJson(event.target.value)
                setPrivateWarning(false)
                setPrivateConfirmed(false)
                setError(null)
              }}
            />
          </label>
          <p className="dshc-dialog-hint">凭据只保存在本机。stdio 会在本机启动命令，请只导入可信配置。</p>
          {privateWarning && (
            <>
              <p className="dshc-warning">{error}</p>
              <label className="dshc-check">
                <input
                  type="checkbox"
                  checked={privateConfirmed}
                  onChange={event => setPrivateConfirmed(event.target.checked)}
                />
                我确认允许访问本机或内网地址
              </label>
            </>
          )}
          {error !== null && !privateWarning && <p className="dshc-dialog-error">{error}</p>}
        </div>
        <div className="dshc-dialog-actions">
          <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" disabled={pending} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="dshc-btn dshc-btn-md dshc-btn-primary"
            disabled={pending || json.trim() === '' || (privateWarning && !privateConfirmed)}
          >
            {pending ? '导入中…' : privateWarning ? '仍然导入' : '导入'}
          </button>
        </div>
      </form>
    </div>
  )
}

interface DeleteDialogProps {
  card: ConnectorCard
  pending: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}

function DeleteCustomDialog({ card, pending, error, onClose, onConfirm }: DeleteDialogProps): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pending])

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !pending) onClose()
      }}
    >
      <div className="dshc-dialog" role="dialog" aria-modal="true" aria-label={`删除 ${card.name}`}>
        <div className="dshc-dialog-head">
          <h2>删除 {card.name}</h2>
          <button type="button" className="dshc-icon-btn" aria-label="关闭" disabled={pending} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          <p className="dshc-dialog-body">这个自定义连接器会从本机移除，已保存的配置与凭据会一起删除，已连接的工具会注销。</p>
          {error !== null && <p className="dshc-dialog-error">{error}</p>}
        </div>
        <div className="dshc-dialog-actions">
          <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" disabled={pending} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="dshc-btn dshc-btn-md dshc-btn-outline dshc-btn-danger"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? '删除中…' : '删除'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConnectorLogo({ card, size = 22 }: { card: ConnectorCard; size?: number }): JSX.Element {
  if (card.icon === 'github') return <BrandGithub size={size} />
  if (card.icon === 'gitlab') return <BrandGitlab size={size} />
  if (card.icon === 'context7') return <BrandContext7 size={size} className="dshc-logo-img" />
  return <CardIcon category={card.category} size={size} />
}

function CardIcon({ category, size = 16 }: { category: string; size?: number }): JSX.Element {
  if (category === '开发工具') return <IconCode size={size} />
  if (category === '知识检索') return <IconGlobe size={size} />
  return <IconLink size={size} />
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dshc-root{
  height:100%;overflow:auto;
  background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);
  font:14px/22px var(--dsw-font-family);
}
.dshc-inner{box-sizing:border-box;max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 48px}
.dshc-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
.dshc-header h1{margin:0;font-size:20px;font-weight:500;line-height:28px;color:var(--dsw-alias-label-primary)}
.dshc-search{box-sizing:border-box;display:flex;align-items:center;gap:6px;height:36px;margin:0 0 16px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary);cursor:text;transition:border-color .15s}
.dshc-search:hover{border-color:var(--dsw-alias-border-l2)}
.dshc-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.dshc-search input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
.dshc-search input::placeholder{color:var(--dsw-alias-label-caption)}
.dshc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
.dshc-btn:disabled{opacity:.4;cursor:not-allowed}
.dshc-btn-md{height:40px}
.dshc-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshc-btn-ghost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dshc-btn-outline{border:.5px solid var(--dsw-alias-border-l3)}
.dshc-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshc-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshc-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dshc-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshc-create{height:32px;padding:0 12px;border-radius:var(--dsw-radius-lg);font-size:13px;line-height:20px}
.dshc-tabs{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:14px}
.dshc-tab{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 10px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
.dshc-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshc-tab-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.dshc-card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:border-color .15s,background-color .15s}
.dshc-card:hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2)}
.dshc-card:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshc-card-top{display:flex;align-items:center;gap:12px;min-width:0}
.dshc-avatar{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;flex:none;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);overflow:hidden}
.dshc-logo-img{border-radius:calc(var(--dsw-radius-md) - 2px)}
.dshc-card-title{display:flex;flex-direction:column;min-width:0}
.dshc-card-title strong{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshc-card-title span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshc-summary{display:-webkit-box;margin:0;min-height:36px;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshc-card-tip{position:fixed;z-index:2000;box-sizing:border-box;max-width:min(360px,calc(100vw - 32px));max-height:min(240px,40vh);padding:6px 9px;overflow:hidden;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00,#fff);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;box-shadow:var(--dsw-elevation-prominent);pointer-events:none;animation:dshc-tip-in .12s ease-out}
@keyframes dshc-tip-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}
.dshc-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto}
.dshc-badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:18px;white-space:nowrap}
.dshc-card-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;background:transparent;color:var(--dsw-alias-label-tertiary)}
button.dshc-card-action{padding:0;cursor:pointer}
button.dshc-card-action:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshc-card-action-connect{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);box-shadow:0 1px 2px color-mix(in srgb,#000 6%,transparent);opacity:0;pointer-events:none;transition:opacity .15s,background-color .15s,border-color .15s,box-shadow .15s,color .15s}
.dshc-card:hover .dshc-card-action-connect,.dshc-card:focus-within .dshc-card-action-connect{opacity:1;pointer-events:auto}
.dshc-card-action-connect:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover));border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);box-shadow:0 2px 5px color-mix(in srgb,#000 8%,transparent)}
.dshc-card:hover .dshc-card-action-connect:disabled,.dshc-card:focus-within .dshc-card-action-connect:disabled{opacity:.4;cursor:not-allowed}
.dshc-card-action-connect.dshc-card-action-loading{opacity:1;pointer-events:auto;cursor:progress}
.dshc-card:hover .dshc-card-action-connect.dshc-card-action-loading,.dshc-card:focus-within .dshc-card-action-connect.dshc-card-action-loading{opacity:1;pointer-events:auto;cursor:progress}
.dshc-spinner{box-sizing:border-box;display:inline-block;width:14px;height:14px;border:2px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:currentColor;border-radius:50%;animation:dshc-spin .8s linear infinite}
@keyframes dshc-spin{to{transform:rotate(360deg)}}
.dshc-card-action-connected{color:var(--dsw-alias-state-success-primary)}
.dshc-card-action-disabled{color:var(--dsw-alias-label-tertiary)}
.dshc-card-action-error{color:var(--dsw-alias-state-error-primary)}
.dshc-card-auth-actions{display:flex;align-items:center;gap:4px;flex:none}
.dshc-card-auth{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.dshc-spinner-inline{width:10px;height:10px;border-width:1.5px}
.dshc-card-auth:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshc-card-auth:disabled{opacity:.4;cursor:not-allowed}
.dshc-card-auth:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshc-card-actions{display:flex;align-items:center;flex:none}
.dshc-card-controls{display:flex;align-items:center;justify-content:flex-end;gap:6px;width:0;opacity:0;overflow:hidden;pointer-events:none;transition:width .26s cubic-bezier(.2,0,0,1),opacity .18s ease}
.dshc-card-controls>*{flex:none}
.dshc-card:hover .dshc-card-controls,.dshc-card:focus-within .dshc-card-controls,.dshc-card-menu-open .dshc-card-controls{width:62px;opacity:1;pointer-events:auto}
.dshc-card-menu-open .dshc-card-controls{overflow:visible}
.dshc-switch{position:relative;box-sizing:border-box;width:28px;height:16px;flex:none;margin:0;padding:0;border:0;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 40%,transparent);cursor:pointer;transition:background-color .15s}
.dshc-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);box-shadow:0 1px 2px color-mix(in srgb,#000 25%,transparent);transition:transform .15s}
.dshc-switch[aria-checked=true]{background:var(--dsw-alias-state-success-primary)}
.dshc-switch[aria-checked=true]::after{transform:translateX(12px)}
.dshc-switch:disabled{opacity:.4;cursor:not-allowed}
.dshc-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshc-card-more-wrap{position:relative;display:inline-flex;flex:none}
.dshc-card-more{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color .15s}
.dshc-card-more:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshc-card-more:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshc-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:168px;padding:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.dshc-menu-item{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.dshc-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshc-menu-item:disabled{opacity:.4;cursor:not-allowed}
.dshc-menu-item-danger{color:var(--dsw-alias-state-error-primary)}
.dshc-dock{box-sizing:border-box;display:inline-flex;align-items:center;gap:0;height:28px;padding:2px 6px;border:0;border-radius:999px;background:transparent;cursor:pointer;flex:none;transition:background-color .15s}
.dshc-dock-single{width:32px;height:32px;padding:4px;gap:0;justify-content:center;border-radius:50%}
.dshc-dock:hover{background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover))}
.dshc-dock-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;border-radius:50%;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1))}
.dshc-dock-icon+.dshc-dock-icon{margin-left:-10px}
.dshc-dock-icon .dshc-logo-img{border-radius:50%}
.dshc-dock-dot{position:absolute;right:0;bottom:0;z-index:2;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}
.dshc-dock-more{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-left:-10px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:500;flex:none;z-index:4}
.dshc-dock-popover{position:absolute;left:0;bottom:calc(100% + 8px);z-index:40;box-sizing:border-box;display:flex;flex-direction:column;width:min(340px,calc(100vw - 32px));max-height:min(460px,60vh);padding:8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.dshc-dock-search{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);flex:none}
.dshc-dock-search input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dshc-dock-search input::placeholder{color:var(--dsw-alias-label-caption)}
.dshc-dock-list{display:flex;flex-direction:column;gap:2px;margin-top:6px;min-height:0;flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.dshc-dock-list::-webkit-scrollbar{width:6px}
.dshc-dock-list::-webkit-scrollbar-thumb{border-radius:999px;background:var(--dsw-alias-scrollbar-bg-l2)}
.dshc-dock-item{display:flex;flex-direction:column}
.dshc-dock-row{display:flex;align-items:center;gap:10px;min-height:38px;padding:4px 6px;border-radius:var(--dsw-radius-md)}
.dshc-dock-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshc-dock-row-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none}
.dshc-dock-row-main{display:flex;flex-direction:column;min-width:0;flex:1}
.dshc-dock-row-name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshc-dock-row-error{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshc-dock-row-state{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshc-dock-row-hint{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshc-dock-connect{flex:none;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dshc-dock-connect:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshc-dock-connect:disabled{opacity:.4;cursor:not-allowed}
.dshc-dock-token{display:flex;align-items:center;gap:6px;padding:2px 6px 6px 38px}
.dshc-dock-token input{box-sizing:border-box;flex:1;min-width:0;height:30px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.dshc-dock-token input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dshc-dock-empty{padding:16px 8px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshc-dock-error{padding:4px 6px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dshc-dock-manage{display:flex;align-items:center;gap:6px;height:32px;margin-top:4px;padding:0 8px;border:0;border-top:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;flex:none}
.dshc-dock-manage:hover{color:var(--dsw-alias-label-primary)}
.dshc-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dshc-overlay ~ .dshc-overlay{background:transparent;backdrop-filter:none}
.dshc-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);max-height:min(800px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent)}
.dshc-dialog-detail,.dshc-dialog-wide{width:min(560px,100%)}
.dshc-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dshc-dialog-head-detail{gap:12px}
.dshc-dialog-head h2{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dshc-dialog-avatar{width:44px;height:44px}
.dshc-dialog-title{display:flex;flex-direction:column;flex:1;min-width:0}
.dshc-dialog-title h2{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshc-dialog-title span{font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshc-icon-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshc-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshc-icon-btn:disabled{opacity:.4;cursor:not-allowed}
.dshc-dialog-content{display:flex;flex-direction:column;gap:16px;min-height:0;padding:0 24px;overflow-y:auto}
.dshc-dialog-body{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshc-dialog-status-pill{flex:none}
.dshc-status-pill{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.dshc-status-pill-connected{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.dshc-status-pill-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.dshc-field{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshc-field input{box-sizing:border-box;height:40px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dshc-field input::placeholder{color:var(--dsw-alias-label-caption)}
.dshc-field input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dshc-field textarea{box-sizing:border-box;min-height:180px;max-height:320px;padding:10px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:12px/18px var(--dsw-font-markdown-code-font-family);outline:none;resize:vertical}
.dshc-field textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dshc-dialog-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshc-link{color:var(--dsw-alias-state-business-primary);text-decoration:none}
.dshc-link:hover{text-decoration:underline}
.dshc-dialog-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dshc-tools{display:flex;flex-direction:column;gap:8px;min-height:0}
.dshc-tools-head{display:flex;align-items:center;gap:8px}
.dshc-tools-head h3{margin:0;font-size:14px;font-weight:500;line-height:20px}
.dshc-tools-count{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:18px}
.dshc-tool-list{max-height:240px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.dshc-tool-list::-webkit-scrollbar{width:6px}
.dshc-tool-list::-webkit-scrollbar-thumb{border-radius:999px;background:var(--dsw-alias-scrollbar-bg-l2)}
.dshc-tool-list::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}
.dshc-tool{padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l3)}
.dshc-tool:first-child{border-top:0}
.dshc-tool-head{display:flex;align-items:center;gap:8px;min-width:0}
.dshc-tool code{display:block;flex:1;min-width:0;font:12px/18px var(--dsw-font-markdown-code-font-family);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dshc-tool-expand{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshc-tool-expand:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshc-tool-chevron{transition:transform .15s}
.dshc-tool-chevron-expanded{transform:rotate(180deg)}
.dshc-tool p{display:-webkit-box;margin:2px 0 0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshc-tool p.dshc-tool-desc-expanded{display:block;overflow:visible;-webkit-line-clamp:unset;white-space:pre-wrap}
.dshc-tools-toggle{align-self:flex-start;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer}
.dshc-tools-toggle:hover{color:var(--dsw-alias-label-primary)}
.dshc-examples{display:flex;flex-direction:column;gap:8px}
.dshc-examples h3{margin:0;font-size:14px;font-weight:500;line-height:20px}
.dshc-example-list{display:flex;flex-direction:column;gap:6px}
.dshc-example{box-sizing:border-box;display:flex;align-items:center;gap:12px;width:100%;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.dshc-example-text{flex:1;min-width:0;overflow-wrap:anywhere}
.dshc-example-actions{display:flex;align-items:center;gap:2px;flex:none}
.dshc-example-action{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshc-example-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshc-example-action:disabled{opacity:.4;cursor:not-allowed}
.dshc-example-action:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshc-example-action-success{color:var(--dsw-alias-state-success-primary)}
.dshc-example-action-error{color:var(--dsw-alias-state-error-primary)}
.dshc-action-tip{transform:translateX(-50%);animation:dshc-action-tip-in .12s ease-out}
.dshc-action-tip-above{transform:translate(-50%,-100%)}
@keyframes dshc-action-tip-in{from{opacity:0}to{opacity:1}}
.dshc-warning{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshc-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshc-check input{margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary)}
.dshc-dialog-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.dshc-dialog-actions-right{display:flex;align-items:center;gap:8px;margin-left:auto}
.dshc-empty{padding:48px 0;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dshc-error{margin-bottom:16px;padding:10px 12px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
`
  document.head.appendChild(style)
}
