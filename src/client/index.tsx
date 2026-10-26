import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import type { CatalogPayload, ConnectionView, ConnectorCard, ConnectionsPayload, CustomConnectorsPayload, OAuthStartPayload, OAuthStatusPayload, ToolInfo } from '../shared/types.js'
import { ROUTE_PREFIX } from '../shared/types.js'
import { IconAlert, IconCheck, IconChevronDown, IconClose, IconCopy, IconEye, IconEyeOff, IconHelp, IconLink, IconMore, IconPlay, IconPlug, IconPlus, IconRefresh, IconSearch, IconTrash } from './icons.js'
import { PROVIDER_ICONS } from './provider-icons.generated.js'
import { BUILTIN_CATEGORIES, canonicalizeCardCategories, parseExampleLines } from '../shared/categories.js'

export const inject: string[] = []

const PANEL_ID = 'dsh-connectors'
const STYLE_ID = 'dsh-connectors-style'
const PROBE_ROUNDS = 6
const PROBE_INTERVAL_MS = 350
const MCP_SERVERS_PLACEHOLDER = `{
  "mcpServers": {
    "my-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." },
      "x-dsh": {
        "description": "查询仓库结构与文档",
        "category": "知识检索",
        "examples": ["用 my-server 查一下最新文档"]
      }
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

const MIN_INSTALL_FEEDBACK_MS = 500

function withInstallFeedback<T>(task: Promise<T>): Promise<T> {
  return Promise.all([task, new Promise<void>(resolve => { setTimeout(resolve, MIN_INSTALL_FEEDBACK_MS) })])
    .then(([value]) => value)
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

const OAUTH_TIMEOUT_MS = 90 * 1000
const OAUTH_POLL_MS = 1200

function isOAuthCard(card: ConnectorCard): boolean {
  return card.auth.type === 'oauth2'
}

function isTokenCard(card: ConnectorCard): boolean {
  return card.auth.type === 'bearer' || card.auth.type === 'header'
}

function tokenLabel(card: ConnectorCard): string {
  const auth = card.auth
  return auth.type === 'bearer' || auth.type === 'header' ? auth.label : '访问令牌'
}

function tokenHelp(card: ConnectorCard): { url: string; label: string; hint?: string } | undefined {
  const auth = card.auth
  return auth.type === 'bearer' || auth.type === 'header' ? auth.help : undefined
}

function Spinner({ inline = false }: { inline?: boolean }): JSX.Element {
  return (
    <svg
      className={inline ? 'dshc-spinner dshc-spinner-inline' : 'dshc-spinner'}
      viewBox="0 0 16 16"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".18" strokeWidth="1.75" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
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
      await request(`${ROUTE_PREFIX}/api/oauth/cancel`, {
        method: 'POST',
        body: JSON.stringify({ flowId }),
      }).catch(() => undefined)
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
}

let dockSnapshot = initialDockSnapshot
const dockListeners = new Set<() => void>()
let dockRequest: Promise<void> | null = null
let dockDirty = false

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
  updateDock({ open: false, query: '', error: null })
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
  updateDock({ pendingId: card.id })
  try {
    await request(`${ROUTE_PREFIX}/api/connections/${encodeURIComponent(card.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  } catch {
    // 失败原因写入连接记录，refreshDock 后由行内状态展示
  } finally {
    await refreshDock()
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
            <ConnectorLogo card={card} size={single ? 24 : 18} />
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
                return (
                  <div className="dshc-dock-item" key={card.id}>
                    <div className="dshc-dock-row">
                      <span className="dshc-dock-row-icon"><ConnectorLogo card={card} size={18} /></span>
                      <span className="dshc-dock-row-main">
                        <span className="dshc-dock-row-name">{card.name}</span>
                        {connection?.error !== undefined
                          ? <span className="dshc-dock-row-error" title={connection.error}>连接失败</span>
                          : connection !== undefined && !connection.authorized
                            ? <span className="dshc-dock-row-state">未授权</span>
                            : null}
                      </span>
                      {connection !== undefined && connection.authorized
                        ? (
                            pending
                              ? <span className="dshc-dock-toggle" role="status" aria-label="处理中">
                                  <Spinner inline />
                                </span>
                              : <button
                                  type="button"
                                  role="switch"
                                  className="dshc-switch"
                                  aria-checked={connection.enabled}
                                  aria-label={connection.enabled ? `停用 ${card.name}` : `启用 ${card.name}`}
                                  title={connection.enabled ? '停用' : '启用'}
                                  onClick={() => { void toggleDockConnection(card, !connection.enabled) }}
                                />
                          )
                        : (
                            <button type="button" className="dshc-dock-connect" onClick={openConnectorPanel}>
                              {connection === undefined ? '去连接' : '去授权'}
                            </button>
                          )}
                    </div>
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
  const [credentialCard, setCredentialCard] = useState<ConnectorCard | null>(null)
  const [credentialSaving, setCredentialSaving] = useState(false)
  const [credentialError, setCredentialError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [togglePending, setTogglePending] = useState<string | null>(null)
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({})
  const [oauthFlow, setOAuthFlow] = useState<(OAuthFlowInfo & { connectorId: string }) | null>(null)
  const [oauthStarting, setOauthStarting] = useState<string | null>(null)
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
        setCards(canonicalizeCardCategories(catalog.value.cards))
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

  const categories = useMemo(() => {
    const present = new Set(cards.map(card => card.category))
    const builtinSet = new Set<string>(BUILTIN_CATEGORIES)
    const builtin = BUILTIN_CATEGORIES.filter(category => present.has(category))
    const custom = [...present]
      .filter(category => !builtinSet.has(category))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    return ['全部', ...builtin, ...custom]
  }, [cards])

  const categoryOptions = useMemo(() => {
    const builtinSet = new Set<string>(BUILTIN_CATEGORIES)
    const custom = [...new Set(
      cards.map(card => card.category).filter(category => !builtinSet.has(category)),
    )].sort((left, right) => left.localeCompare(right, 'zh-CN'))
    return [...BUILTIN_CATEGORIES, ...custom]
  }, [cards])

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

  const openCredentialDialog = (card: ConnectorCard): void => {
    setCredentialError(null)
    setCredentialCard(card)
  }

  const saveCredential = (card: ConnectorCard, token: string): void => {
    setCredentialSaving(true)
    setCredentialError(null)
    void (async () => {
      try {
        const response = await withInstallFeedback(request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections`, {
          method: 'POST',
          body: JSON.stringify({ connectorId: card.id, token }),
        }))
        const connection = response.value?.connection
        if (connection === undefined) throw new ApiError('invalid_response', '保存失败：宿主没有返回连接')
        applyConnection(connection)
        setCredentialCard(null)
      } catch (cause) {
        setCredentialError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setCredentialSaving(false)
      }
    })()
  }

  const clearCardError = (connectorId: string): void => {
    setCardErrors(previous => {
      if (previous[connectorId] === undefined) return previous
      const next = { ...previous }
      delete next[connectorId]
      return next
    })
  }

  const setCardError = (connectorId: string, message: string): void => {
    setCardErrors(previous => ({ ...previous, [connectorId]: message }))
  }

  const applyConnection = (connection: ConnectionView): void => {
    setConnections(previous => ({ ...previous, [connection.connectorId]: connection }))
    clearCardError(connection.connectorId)
    notifyConnectionsChanged()
  }

  const connect = (card: ConnectorCard, token?: string, surface: 'dialog' | 'page' = 'dialog'): Promise<boolean> => {
    setPending(card.id)
    if (surface === 'dialog') setDialogError(null)
    else clearCardError(card.id)
    return (async () => {
      try {
        const response = await withInstallFeedback(request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections`, {
          method: 'POST',
          body: JSON.stringify(token === undefined ? { connectorId: card.id } : { connectorId: card.id, token }),
        }))
        const connection = response.value?.connection
        if (connection !== undefined) {
          applyConnection(connection)
          if (connection.authorized && connection.error === undefined && connection.tools.length === 0) refreshSoon()
          setDialogInstall(false)
        }
        setDialogError(null)
        return true
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (surface === 'dialog') setDialogError(message)
        else setCardError(card.id, message)
        return false
      } finally {
        setPending(null)
      }
    })()
  }

  const installConnector = async (card: ConnectorCard): Promise<ConnectionView> => {
    const response = await withInstallFeedback(request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections`, {
      method: 'POST',
      body: JSON.stringify({ connectorId: card.id }),
    }))
    const connection = response.value?.connection
    if (connection === undefined) throw new ApiError('invalid_response', '安装失败：宿主没有返回连接')
    return connection
  }

  const installRecord = (card: ConnectorCard, surface: 'dialog' | 'page'): void => {
    setPending(card.id)
    if (surface === 'dialog') setDialogError(null)
    else clearCardError(card.id)
    void (async () => {
      try {
        const connection = await installConnector(card)
        applyConnection(connection)
        setDialogCard(card)
        setDialogInstall(false)
        if (surface === 'dialog') setDialogError(null)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (surface === 'dialog') setDialogError(message)
        else setCardError(card.id, message)
      } finally {
        setPending(null)
      }
    })()
  }

  const runOAuth = (card: ConnectorCard, installFirst: boolean, surface: 'dialog' | 'page' = 'dialog', force = false, presetConnection?: ConnectionView): void => {
    const controller = new AbortController()
    oauthAbortRef.current = controller
    setOauthStarting(card.id)
    setPending(card.id)
    if (surface === 'dialog') setDialogError(null)
    else clearCardError(card.id)
    void (async () => {
      try {
        let connection = presetConnection ?? connections[card.id]
        if (presetConnection === undefined && (installFirst || connection === undefined)) {
          connection = await installConnector(card)
          applyConnection(connection)
          setDialogInstall(false)
        }
        if (connection === undefined) {
          throw new ApiError('not_installed', '请先安装连接器，再发起授权')
        }
        if (force || !connection.authorized) {
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
          else setCardError(card.id, message)
        }
        refreshConnections()
      } finally {
        setPending(null)
        setOauthStarting(null)
        setOAuthFlow(null)
        oauthAbortRef.current = null
      }
    })()
  }

  const configureInstance = (card: ConnectorCard, instanceUrl: string): void => {
    setPending(card.id)
    setDialogError(null)
    void (async () => {
      try {
        const response = await withInstallFeedback(request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections`, {
          method: 'POST',
          body: JSON.stringify({ connectorId: card.id, instanceUrl }),
        }))
        const connection = response.value?.connection
        if (connection === undefined) throw new ApiError('invalid_response', '安装失败：宿主没有返回连接')
        applyConnection(connection)
        setDialogInstall(false)
        setPending(null)
        runOAuth(card, false, 'dialog', false, connection)
      } catch (cause) {
        setDialogError(cause instanceof Error ? cause.message : String(cause))
        setPending(null)
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
    else clearCardError(card.id)
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
        else setCardError(card.id, message)
      } finally {
        setPending(null)
      }
    })()
  }

  const disconnect = (card: ConnectorCard): void => {
    setPending(card.id)
    clearCardError(card.id)
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
        setCardError(card.id, cause instanceof Error ? cause.message : String(cause))
      } finally {
        setPending(null)
      }
    })()
  }

  const onImported = (imported: ConnectorCard[], connectNow: boolean): void => {
    const canonical = canonicalizeCardCategories(imported)
    setCards(previous => {
      const existing = new Set(previous.map(card => card.id))
      return canonicalizeCardCategories([
        ...previous,
        ...canonical.filter(card => !existing.has(card.id)),
      ])
    })
    if (canonical[0] !== undefined) setCategory(canonical[0].category)
    notifyConnectionsChanged()
    if (connectNow && canonical[0] !== undefined && canonical.length === 1) {
      void connect(canonical[0], undefined, 'page')
    }
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
    clearCardError(card.id)
    void (async () => {
      try {
        const response = await request<ConnectResponse>(
          `${ROUTE_PREFIX}/api/connections/${encodeURIComponent(card.id)}`,
          { method: 'PATCH', body: JSON.stringify({ enabled }) },
        )
        const connection = response.value?.connection
        if (connection !== undefined) {
          applyConnection(connection)
        }
      } catch (cause) {
        setCardError(card.id, cause instanceof Error ? cause.message : String(cause))
        refreshConnections()
      } finally {
        setTogglePending(null)
      }
    })()
  }

  const startTrialFor = (card: ConnectorCard): void => {
    clearCardError(card.id)
    try {
      startTrial(promptForNextExample(card))
    } catch (cause) {
      setCardError(card.id, cause instanceof Error ? cause.message : String(cause))
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
    && (oauthStarting === card.id
      || oauthFlow?.connectorId === card.id
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
                  errorMessage={cardErrors[card.id]}
                  togglePending={togglePending === card.id}
                  authorizing={isAuthorizing(card)}
                  installing={pending === card.id}
                  onOpen={() => openDialog(card, false)}
                  onInstall={() => {
                    if (isOAuthCard(card)) {
                      if (card.instance !== undefined) {
                        installRecord(card, 'page')
                        return
                      }
                      runOAuth(card, true, 'page')
                      return
                    }
                    if (isTokenCard(card)) {
                      installRecord(card, 'page')
                      return
                    }
                    if (card.auth.type === 'none') {
                      connect(card, undefined, 'page')
                      return
                    }
                    openDialog(card, true)
                  }}
                  onAuthorize={() => {
                    if (isOAuthCard(card)) {
                      if (card.instance !== undefined && connections[card.id]?.instanceReady !== true) {
                        openDialog(card, false)
                        return
                      }
                      runOAuth(card, false, 'page')
                      return
                    }
                    openDialog(card, false)
                  }}
                  onCancelAuthorize={cancelAuthorize}
                  onUpdateCredential={isTokenCard(card) && connections[card.id]?.authorized === true
                    ? () => openCredentialDialog(card)
                    : undefined}
                  onReauthorize={isOAuthCard(card) && connections[card.id]?.authorized === true
                    ? () => runOAuth(card, false, 'page', true)
                    : undefined}
                  onRevoke={isOAuthCard(card)
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
          authorizeLink={oauthFlow?.connectorId === dialogCard.id ? oauthFlow.authorizeUrl : null}
          installOpen={dialogInstall}
          error={dialogError}
          behind={credentialCard !== null || deleteCard !== null}
          escLocked={credentialCard !== null || deleteCard !== null}
          onClose={() => {
            if (pending === null) {
              setDialogCard(null)
              setDialogInstall(false)
              setDialogError(null)
            }
          }}
          onBeginInstall={() => {
            if (isTokenCard(dialogCard) || dialogCard.instance !== undefined) {
              installRecord(dialogCard, 'dialog')
              return
            }
            if (dialogCard.auth.type === 'none') {
              void connect(dialogCard, undefined, 'dialog')
              return
            }
            setDialogError(null)
            setDialogInstall(true)
          }}
          onCancelInstall={() => {
            setDialogInstall(false)
            setDialogError(null)
          }}
          onConnect={token => connect(dialogCard, token)}
          onInstallOAuth={() => runOAuth(dialogCard, true)}
          onConfigureInstance={instanceUrl => configureInstance(dialogCard, instanceUrl)}
          onAuthorize={() => runOAuth(dialogCard, false)}
          onReauthorize={() => runOAuth(dialogCard, false, 'dialog', true)}
          onUpdateCredential={() => openCredentialDialog(dialogCard)}
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

      {credentialCard !== null && (
        <CredentialDialog
          card={credentialCard}
          saving={credentialSaving}
          error={credentialError}
          onClose={() => {
            if (!credentialSaving) {
              setCredentialCard(null)
              setCredentialError(null)
            }
          }}
          onSubmit={token => saveCredential(credentialCard, token)}
        />
      )}

      {customOpen && (
        <CustomConnectorDialog
          onClose={() => setCustomOpen(false)}
          categoryOptions={categoryOptions}
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
  errorMessage?: string
  togglePending: boolean
  authorizing: boolean
  installing: boolean
  onOpen: () => void
  onInstall: () => void
  onAuthorize: () => void
  onCancelAuthorize: () => void
  onUpdateCredential?: () => void
  onReauthorize?: () => void
  onRevoke?: () => void
  onTrial: () => void
  onToggle: (enabled: boolean) => void
  onDisconnect: () => void
  onDelete?: () => void
}

function ConnectorCardView({ card, connection, errorMessage, togglePending, authorizing, installing, onOpen, onInstall, onAuthorize, onCancelAuthorize, onUpdateCredential, onReauthorize, onRevoke, onTrial, onToggle, onDisconnect, onDelete }: CardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [tip, setTip] = useState<CardTip | null>(null)
  const menuRef = useRef<HTMLSpanElement>(null)
  const connected = connection !== undefined && connection.authorized && connection.enabled && connection.error === undefined
  const unauthorized = connection !== undefined && !connection.authorized
  const toolCount = connection?.tools.length ?? 0
  const error = connection?.error ?? errorMessage
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
  const deleteItem = (
    <button
      type="button"
      role="menuitem"
      className="dshc-menu-item dshc-menu-item-danger"
      onClick={() => {
        setMenuOpen(false)
        if (onDelete !== undefined) onDelete()
        else onDisconnect()
      }}
    >
      <IconTrash size={14} />
      删除
    </button>
  )
  const disconnectItem = onDelete === undefined ? null : (
    <button
      type="button"
      role="menuitem"
      className="dshc-menu-item"
      onClick={() => {
        setMenuOpen(false)
        onDisconnect()
      }}
    >
      <IconPlug size={14} />
      断开
    </button>
  )

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
          <span>{card.vendor ?? card.server.transport}</span>
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
      {error !== undefined && <p className="dshc-card-error" title={error}>{error}</p>}
      <div className="dshc-card-foot">
        <span className="dshc-badge">{card.category}</span>
        {connection === undefined ? (
          <span className="dshc-card-install-actions">
            {onDelete !== undefined && (
              <span className="dshc-card-more-wrap dshc-card-more-float" ref={menuRef}>
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
                    {deleteItem}
                  </span>
                )}
              </span>
            )}
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
              {installing ? <Spinner /> : <IconPlus size={16} />}
            </button>
          </span>
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
              {authorizing && <Spinner inline />}
              {authorizing ? '取消授权' : '授权'}
            </button>
            <span className="dshc-card-installed" role="img" aria-label="已安装，待授权" title="已安装，待授权">
              <IconCheck size={14} />
            </span>
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
                  {disconnectItem}
                  {deleteItem}
                </span>
              )}
            </span>
          </span>
        ) : (
          <span className="dshc-card-actions">
            <span className={`${actionClass} dshc-card-status`} title={authorizing ? '授权中…' : actionText} aria-hidden>
              {authorizing
                ? <Spinner />
                : error !== undefined
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
                    {onUpdateCredential !== undefined && (
                      <button
                        type="button"
                        role="menuitem"
                        className="dshc-menu-item"
                        onClick={() => {
                          setMenuOpen(false)
                          onUpdateCredential()
                        }}
                      >
                        <IconRefresh size={14} />
                        更新令牌
                      </button>
                    )}
                    {onReauthorize !== undefined && (
                      <button
                        type="button"
                        role="menuitem"
                        className="dshc-menu-item"
                        onClick={() => {
                          setMenuOpen(false)
                          onReauthorize()
                        }}
                      >
                        <IconRefresh size={14} />
                        重新授权
                      </button>
                    )}
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
                    {disconnectItem}
                    {deleteItem}
                  </span>
                )}
              </span>
              {togglePending
                ? <span className="dshc-card-toggle" role="status" aria-label="处理中">
                    <Spinner />
                  </span>
                : <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={enabled ? `停用 ${card.name}` : `启用 ${card.name}`}
                    title={enabled ? '停用' : '启用'}
                    className="dshc-switch"
                    onClick={event => {
                      event.stopPropagation()
                      onToggle(!enabled)
                    }}
                  />}
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
  behind?: boolean
  escLocked?: boolean
  onClose: () => void
  onBeginInstall: () => void
  onCancelInstall: () => void
  onConnect: (token?: string) => Promise<boolean>
  onInstallOAuth: () => void
  onConfigureInstance: (instanceUrl: string) => void
  onAuthorize: () => void
  onReauthorize: () => void
  onUpdateCredential: () => void
  onCancelAuthorize: () => void
  onTryExample: (example: string) => void
  onRevoke: () => void
  onDisconnect: () => void
  onToggle: (enabled: boolean) => void
  onDelete?: () => void
}

function ConnectorDialog({ card, connection, pending, toggling, authorizing, authorizeLink, installOpen, error, behind = false, escLocked = false, onClose, onBeginInstall, onCancelInstall, onConnect, onInstallOAuth, onConfigureInstance, onAuthorize, onReauthorize, onUpdateCredential, onCancelAuthorize, onTryExample, onRevoke, onDisconnect, onToggle, onDelete }: ConnectorDialogProps): JSX.Element {
  const [token, setToken] = useState('')
  const [tokenVisible, setTokenVisible] = useState(false)
  const [instanceUrl, setInstanceUrl] = useState('')
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
  const needsToken = isTokenCard(card)
  const help = tokenHelp(card)
  const oauth = isOAuthCard(card)
  const unauthorized = connection !== undefined && !connection.authorized
  const disabled = connection !== undefined && connection.authorized && !connection.enabled
  const connected = connection !== undefined && connection.authorized && connection.enabled && connection.error === undefined
  const toolDetails: ToolInfo[] = connection?.toolDetails ?? (connection?.tools ?? []).map(name => ({ name }))
  const canTry = connected && toolDetails.length > 0
  const visibleTools = showAllTools ? toolDetails : toolDetails.slice(0, 4)
  const examples = card.examples ?? []
  const instance = card.instance
  const showingInstall = installOpen && instance === undefined && connection === undefined && !needsToken
  const needsInstanceConfig = instance !== undefined
    && connection !== undefined
    && !connection.authorized
    && connection.instanceReady !== true
  const failedWithToken = needsToken && connection !== undefined && connection.authorized && connection.error !== undefined
  const tokenEntry = needsToken && connection !== undefined && (!connection.authorized || connection.error !== undefined)
  const busy = pending || toggling
  const removeLabel = onDelete === undefined ? '删除' : '断开'
  const removingLabel = onDelete === undefined ? '删除中…' : '断开中…'
  const removeClass = onDelete === undefined
    ? 'dshc-btn dshc-btn-md dshc-btn-outline dshc-btn-danger'
    : 'dshc-btn dshc-btn-md dshc-btn-outline'

  useEffect(() => {
    setToken('')
    setTokenVisible(false)
    setInstanceUrl('')
    setCopied(null)
    setCopyFailed(null)
    setShowAllTools(false)
    setExpandedTool(null)
  }, [card.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy && !escLocked) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy, escLocked])

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

  const statusText = connection === undefined
    ? '未连接'
    : unauthorized
      ? (authorizing ? '授权中' : '未授权')
      : disabled
        ? '已停用'
        : connected
          ? '已连接'
          : '连接失败'
  const statusClass = connection === undefined || unauthorized || disabled
    ? 'dshc-status-pill'
    : connected
      ? 'dshc-status-pill dshc-status-pill-connected'
      : 'dshc-status-pill dshc-status-pill-error'

  return (
    <div
      className={behind ? 'dshc-overlay dshc-overlay-behind' : 'dshc-overlay'}
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

          {needsInstanceConfig && instance !== undefined && (
            <div className="dshc-field">
              <label htmlFor="dshc-instance-url">{instance.label}</label>
              <input
                id="dshc-instance-url"
                type="url"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder={instance.placeholder ?? 'https://gitlab.example.com'}
                value={instanceUrl}
                onChange={event => setInstanceUrl(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !pending && instanceUrl.trim() !== '') {
                    event.preventDefault()
                    onConfigureInstance(instanceUrl.trim())
                  }
                }}
              />
            </div>
          )}
          {needsInstanceConfig && instance?.hint !== undefined && (
            <p className="dshc-dialog-hint">{instance.hint}</p>
          )}
          {needsInstanceConfig && instanceUrl.trim().startsWith('http://') && (
            <p className="dshc-dialog-hint">非 https 地址会明文传输，请确认网络可信。</p>
          )}

          {needsToken && tokenEntry && (
            <div className="dshc-field">
              <label htmlFor="dshc-token-input">{tokenLabel(card)}</label>
              <span className="dshc-field-control">
                <input
                  id="dshc-token-input"
                  type={tokenVisible ? 'text' : 'password'}
                  autoFocus
                  autoComplete="off"
                  placeholder={failedWithToken ? '粘贴新令牌' : '粘贴令牌'}
                  value={token}
                  onChange={event => setToken(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !pending && token.trim() !== '') {
                      event.preventDefault()
                      void onConnect(token)
                    }
                  }}
                />
                <button
                  type="button"
                  className="dshc-field-reveal"
                  aria-label={tokenVisible ? '隐藏令牌' : '显示令牌'}
                  title={tokenVisible ? '隐藏令牌' : '显示令牌'}
                  aria-pressed={tokenVisible}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => setTokenVisible(current => !current)}
                >
                  {tokenVisible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
              </span>
            </div>
          )}
          {needsToken && tokenEntry && help !== undefined && (
            <p className="dshc-dialog-hint">
              <a className="dshc-link" href={help.url} target="_blank" rel="noreferrer">
                {help.label}
              </a>
              {help.hint !== undefined && <span>　{help.hint}</span>}
            </p>
          )}
          {oauth && showingInstall && (
            <p className="dshc-dialog-hint">安装后会自动打开默认浏览器完成 {card.name} 授权。</p>
          )}
          {oauth && unauthorized && (
            <p className="dshc-dialog-hint">
              {authorizing
                ? '已打开授权页，完成授权后会自动同步；如已关闭授权页，请点「取消授权」后重试。'
                : needsInstanceConfig
                  ? '已安装，填写实例地址后开始授权。'
                  : `已安装，点击授权后在浏览器完成 ${card.name} 授权。`}
            </p>
          )}
          {authorizeLink !== null && authorizing && (
            <p className="dshc-dialog-hint">
              没有自动打开浏览器？
              <a className="dshc-link" href={authorizeLink} target="_blank" rel="noreferrer">点此授权</a>
            </p>
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

          {examples.length > 0 && (
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
          )}
        </div>

        <div className="dshc-dialog-actions">
          {onDelete !== undefined && (
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost dshc-btn-danger" disabled={busy} onClick={onDelete}>
              删除
            </button>
          )}
          {oauth && connection?.authorized === true && !authorizing && (
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost" disabled={busy} onClick={onRevoke}>
              取消授权
            </button>
          )}
          <span className="dshc-dialog-actions-right">
            {authorizing && connection?.authorized === true && (
              <>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onCancelAuthorize}>
                  取消授权
                </button>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled>
                  <Spinner />
                  授权中…
                </button>
              </>
            )}
            {unauthorized && (
              authorizing ? (
                <>
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onCancelAuthorize}>
                    取消授权
                  </button>
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled>
                    <Spinner />
                    授权中…
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className={removeClass} disabled={busy} onClick={onDisconnect}>
                    {removeLabel}
                  </button>
                  {oauth ? (
                    needsInstanceConfig ? (
                      <button
                        type="button"
                        className="dshc-btn dshc-btn-md dshc-btn-primary"
                        disabled={busy || instanceUrl.trim() === ''}
                        onClick={() => onConfigureInstance(instanceUrl.trim())}
                      >
                        {pending && <Spinner />}
                        {pending ? '配置中…' : '配置并授权'}
                      </button>
                    ) : (
                      <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled={busy} onClick={onAuthorize}>
                        授权 {card.name}
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      className="dshc-btn dshc-btn-md dshc-btn-primary"
                      disabled={busy || token.trim() === ''}
                      onClick={() => onConnect(token)}
                    >
                      {pending ? '连接中…' : '连接'}
                    </button>
                  )}
                </>
              )
            )}
            {!authorizing && disabled && (
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
            {!authorizing && connected && (
              <>
                <button type="button" className={removeClass} disabled={busy} onClick={onDisconnect}>
                  {pending ? removingLabel : removeLabel}
                </button>
                {oauth && (
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost" disabled={busy} onClick={onReauthorize}>
                    重新授权
                  </button>
                )}
                {needsToken && (
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost" disabled={busy} onClick={onUpdateCredential}>
                    更新令牌
                  </button>
                )}
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled={busy} onClick={onClose}>
                  完成
                </button>
              </>
            )}
            {!authorizing && connection !== undefined && connection.authorized && !connected && !disabled && (
              <>
                <button type="button" className={removeClass} disabled={busy} onClick={onDisconnect}>
                  {removeLabel}
                </button>
                {oauth ? (
                  <button
                    type="button"
                    className="dshc-btn dshc-btn-md dshc-btn-primary"
                    disabled={busy}
                    onClick={onReauthorize}
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
            {connection === undefined && showingInstall && (
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
                    {pending && <Spinner />}
                    {pending ? '安装中…' : '安装'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="dshc-btn dshc-btn-md dshc-btn-primary"
                    disabled={busy || (needsToken && token.trim() === '')}
                    onClick={() => onConnect(needsToken ? token : undefined)}
                  >
                    {pending && <Spinner />}
                    {pending ? (needsToken ? '连接中…' : '安装中…') : (needsToken ? '连接' : '安装')}
                  </button>
                )}
              </>
            )}
            {connection === undefined && !showingInstall && (
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
                  {pending && <Spinner />}
                  {pending ? '安装中…' : '安装'}
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

interface CredentialDialogProps {
  card: ConnectorCard
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (token: string) => void
}

function CredentialDialog({ card, saving, error, onClose, onSubmit }: CredentialDialogProps): JSX.Element {
  const [token, setToken] = useState('')
  const [tokenVisible, setTokenVisible] = useState(false)
  const help = tokenHelp(card)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const submit = (): void => {
    if (saving || token.trim() === '') return
    onSubmit(token)
  }

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !saving) onClose()
      }}
    >
      <div className="dshc-dialog dshc-dialog-credential" role="dialog" aria-modal="true" aria-label={`更新 ${card.name} 令牌`}>
        <div className="dshc-dialog-head">
          <span className="dshc-dialog-avatar"><ConnectorLogo card={card} size={28} /></span>
          <div className="dshc-dialog-title">
            <h2>更新令牌</h2>
            <span>{card.name}</span>
          </div>
          <button type="button" className="dshc-icon-btn" aria-label="关闭" disabled={saving} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          <p className="dshc-dialog-hint">当前令牌不会显示；保存新令牌后立即替换。</p>
          <div className="dshc-field">
            <label htmlFor="dshc-credential-token">{tokenLabel(card)}</label>
            <span className="dshc-field-control">
              <input
                id="dshc-credential-token"
                type={tokenVisible ? 'text' : 'password'}
                autoFocus
                autoComplete="off"
                placeholder="粘贴新令牌"
                value={token}
                onChange={event => setToken(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submit()
                  }
                }}
              />
              <button
                type="button"
                className="dshc-field-reveal"
                aria-label={tokenVisible ? '隐藏令牌' : '显示令牌'}
                title={tokenVisible ? '隐藏令牌' : '显示令牌'}
                aria-pressed={tokenVisible}
                onMouseDown={event => event.preventDefault()}
                onClick={() => setTokenVisible(current => !current)}
              >
                {tokenVisible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
            </span>
          </div>
          {help !== undefined && (
            <p className="dshc-dialog-hint">
              <a className="dshc-link" href={help.url} target="_blank" rel="noreferrer">
                {help.label}
              </a>
              {help.hint !== undefined && <span>　{help.hint}</span>}
            </p>
          )}
          {error !== null && <p className="dshc-dialog-error">{error}</p>}
        </div>
        <div className="dshc-dialog-actions">
          <span className="dshc-dialog-actions-right">
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" disabled={saving} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="dshc-btn dshc-btn-md dshc-btn-primary"
              disabled={saving || token.trim() === ''}
              onClick={submit}
            >
              {saving && <Spinner />}
              {saving ? '保存中…' : '保存'}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

interface CustomDialogProps {
  onClose: () => void
  categoryOptions: string[]
  onImported: (connectors: ConnectorCard[], connectNow: boolean) => void
}

function CustomConnectorDialog({ onClose, categoryOptions, onImported }: CustomDialogProps): JSX.Element {
  const [json, setJson] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [examples, setExamples] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [privateWarning, setPrivateWarning] = useState(false)
  const [privateConfirmed, setPrivateConfirmed] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [categoryMenu, setCategoryMenu] = useState<{ left: number; top: number; width: number } | null>(null)
  const [helpTip, setHelpTip] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const categoryRef = useRef<HTMLDivElement>(null)
  const categoryMenuRef = useRef<HTMLDivElement>(null)
  const categoryInputRef = useRef<HTMLInputElement>(null)
  const helpHideTimerRef = useRef<number | null>(null)
  const helpHoverRef = useRef(false)
  const parsedJson = useMemo<{
    count: number
    meta: { description?: string; category?: string; examples?: string[] } | null
  }>(() => {
    try {
      const parsed = JSON.parse(json) as { mcpServers?: unknown }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { count: 0, meta: null }
      }
      const servers = parsed.mcpServers
      if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
        return { count: 0, meta: null }
      }
      const entries = Object.entries(servers)
      if (entries.length !== 1) return { count: entries.length, meta: null }
      const server = entries[0]?.[1]
      if (server === null || typeof server !== 'object' || Array.isArray(server)) {
        return { count: 1, meta: null }
      }
      const xdsh = (server as Record<string, unknown>)['x-dsh']
      if (xdsh === null || typeof xdsh !== 'object' || Array.isArray(xdsh)) {
        return { count: 1, meta: null }
      }
      const record = xdsh as Record<string, unknown>
      const description = typeof record.description === 'string' && record.description.trim() !== ''
        ? record.description.trim()
        : undefined
      const category = typeof record.category === 'string' && record.category.trim() !== ''
        ? record.category.trim()
        : undefined
      const examples = Array.isArray(record.examples)
        ? record.examples
          .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
          .map(item => item.trim())
        : undefined
      return {
        count: 1,
        meta: {
          ...(description === undefined ? {} : { description }),
          ...(category === undefined ? {} : { category }),
          ...(examples === undefined || examples.length === 0 ? {} : { examples }),
        },
      }
    } catch {
      return { count: 0, meta: null }
    }
  }, [json])
  const serverCount = parsedJson.count
  const jsonMeta = parsedJson.meta
  const hasJsonMeta = jsonMeta !== null
    && (jsonMeta.description !== undefined || jsonMeta.category !== undefined || jsonMeta.examples !== undefined)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || pending) return
      if (categoryOpen) {
        setCategoryOpen(false)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pending, categoryOpen])

  useEffect(() => {
    if (!categoryOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (categoryRef.current?.contains(target) === true || categoryMenuRef.current?.contains(target) === true) return
      setCategoryOpen(false)
    }
    const close = (): void => setCategoryOpen(false)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [categoryOpen])

  const openCategoryMenu = (): void => {
    const rect = categoryInputRef.current?.getBoundingClientRect()
    if (rect !== undefined) {
      setCategoryMenu({ left: rect.left, top: rect.bottom + 4, width: rect.width })
    }
    setCategoryOpen(true)
  }

  const cancelHelpTipHide = (): void => {
    if (helpHideTimerRef.current !== null) {
      window.clearTimeout(helpHideTimerRef.current)
      helpHideTimerRef.current = null
    }
  }

  const showHelpTip = (element: HTMLElement): void => {
    cancelHelpTipHide()
    const rect = element.getBoundingClientRect()
    const width = Math.min(380, window.innerWidth - 32)
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))
    const above = rect.bottom + 220 > window.innerHeight
    setHelpTip({ left, top: above ? rect.top - 8 : rect.bottom + 8, above })
  }

  const hideHelpTipSoon = (): void => {
    if (helpHoverRef.current) return
    cancelHelpTipHide()
    helpHideTimerRef.current = window.setTimeout(() => {
      helpHideTimerRef.current = null
      if (!helpHoverRef.current) setHelpTip(null)
    }, 140)
  }

  useEffect(() => () => cancelHelpTipHide(), [])

  const submit = (connectNow: boolean): void => {
    setPending(true)
    setError(null)
    const exampleLines = parseExampleLines(examples)
    void (async () => {
      try {
        const response = await request<CustomConnectorsPayload>(`${ROUTE_PREFIX}/api/custom-connectors`, {
          method: 'POST',
          body: JSON.stringify({
            json,
            allowPrivate: privateWarning,
            ...(description.trim() === '' ? {} : { description: description.trim() }),
            ...(category.trim() === '' ? {} : { category: category.trim() }),
            ...(exampleLines.length === 0 ? {} : { examples: exampleLines }),
          }),
        })
        onImported(response.value.connectors, connectNow)
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
          if (!pending && json.trim() !== '' && (!privateWarning || privateConfirmed)) {
            submit(serverCount === 1)
          }
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
          <div className="dshc-field">
            <span className="dshc-field-label">
              <span>mcpServers JSON</span>
              <button
                type="button"
                className="dshc-help-btn"
                aria-label="x-dsh 说明"
                onMouseEnter={event => showHelpTip(event.currentTarget)}
                onMouseLeave={hideHelpTipSoon}
                onFocus={event => showHelpTip(event.currentTarget)}
                onBlur={hideHelpTipSoon}
              >
                <IconHelp size={14} />
              </button>
            </span>
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
          </div>
          {hasJsonMeta && (
            <p className="dshc-dialog-hint">已读取 JSON 中的 x-dsh；下方留空就使用它，填写会覆盖。</p>
          )}
          <label className="dshc-field">
            <span>描述（可选）</span>
            <input
              autoComplete="off"
              maxLength={120}
              placeholder={jsonMeta?.description === undefined
                ? '例如：通过 DeepWiki 查询仓库结构与文档'
                : `JSON 中：${jsonMeta.description}`}
              value={description}
              onChange={event => setDescription(event.target.value)}
            />
          </label>
          <div className="dshc-field">
            <span className="dshc-field-label">
              <span>类别（可选）</span>
            </span>
            <div className="dshc-select" ref={categoryRef}>
              <div className="dshc-select-control">
                <input
                  ref={categoryInputRef}
                  autoComplete="off"
                  placeholder={jsonMeta?.category === undefined ? '默认：其他' : `JSON 中：${jsonMeta.category}`}
                  value={category}
                  aria-expanded={categoryOpen}
                  onFocus={openCategoryMenu}
                  onChange={event => {
                    setCategory(event.target.value)
                    openCategoryMenu()
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      setCategoryOpen(false)
                    }
                  }}
                />
                <button
                  type="button"
                  className="dshc-select-toggle"
                  aria-label="选择类别"
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => {
                    if (categoryOpen) setCategoryOpen(false)
                    else openCategoryMenu()
                  }}
                >
                  <IconChevronDown size={14} />
                </button>
              </div>
            </div>
            <p className="dshc-dialog-hint">
              {jsonMeta?.category === undefined
                ? '留空会归入「其他」；可直接输入新类别。'
                : '留空使用 JSON 中的类别；填写会覆盖。'}
            </p>
          </div>
          <label className="dshc-field">
            <span>示例提示词（可选，每行一条）</span>
            <textarea
              className="dshc-examples-input"
              spellCheck={false}
              placeholder={jsonMeta?.examples === undefined
                ? '用 DeepWiki 查一下 facebook/react 的仓库结构'
                : `JSON 中：\n${jsonMeta.examples.join('\n')}`}
              value={examples}
              onChange={event => setExamples(event.target.value)}
            />
          </label>
          {serverCount > 1 && (
            <p className="dshc-warning">
              检测到 {serverCount} 个 Server；多 Server 请用「仅导入」，导入后分别连接。
              填写下方描述、类别、示例会覆盖所有 Server；留空则各 Server 使用自己的 x-dsh。
            </p>
          )}
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
            type="button"
            className="dshc-btn dshc-btn-md dshc-btn-outline"
            disabled={pending || json.trim() === '' || (privateWarning && !privateConfirmed)}
            onClick={() => submit(false)}
          >
            {privateWarning ? '仍然仅导入' : '仅导入'}
          </button>
          <button
            type="submit"
            className="dshc-btn dshc-btn-md dshc-btn-primary"
            disabled={pending || json.trim() === '' || serverCount !== 1 || (privateWarning && !privateConfirmed)}
          >
            {pending ? '导入中…' : privateWarning ? '仍然导入并连接' : '导入并连接'}
          </button>
        </div>
      </form>
      {categoryOpen && categoryMenu !== null && createPortal(
        <div
          ref={categoryMenuRef}
          className="dshc-select-menu dshc-select-menu-portal"
          style={{ left: categoryMenu.left, top: categoryMenu.top, width: categoryMenu.width }}
          role="listbox"
        >
          {categoryOptions.map(item => (
            <button
              key={item}
              type="button"
              role="option"
              aria-selected={category === item}
              className={category === item
                ? 'dshc-select-item dshc-select-item-active'
                : 'dshc-select-item'}
              onClick={() => {
                setCategory(item)
                setCategoryOpen(false)
              }}
            >
              {item}
            </button>
          ))}
        </div>,
        document.body,
      )}
      {helpTip !== null && createPortal(
        <div
          className="dshc-card-tip dshc-help-tip"
          style={{
            left: helpTip.left,
            top: helpTip.top,
            ...(helpTip.above ? { transform: 'translateY(-100%)' } : {}),
          }}
          onMouseEnter={() => {
            helpHoverRef.current = true
            cancelHelpTipHide()
          }}
          onMouseLeave={() => {
            helpHoverRef.current = false
            cancelHelpTipHide()
            setHelpTip(null)
          }}
        >
          <strong>可选扩展：x-dsh</strong>
          <span>可在每个 server 配置里指定描述、类别与示例，优先于下方表单：</span>
          <code>{`"x-dsh": {
  "description": "查询仓库结构与文档",
  "category": "知识检索",
  "examples": ["用 DeepWiki 查 facebook/react 的仓库结构"]
}`}</code>
        </div>,
        document.body,
      )}
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
  const src = PROVIDER_ICONS[card.id]
  if (src !== undefined) {
    return <img width={size} height={size} className="dshc-logo-img" src={src} alt="" />
  }
  return (
    <span
      className="dshc-logo-fallback"
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.44)) }}
      aria-hidden
    >
      {card.name.slice(0, 1).toUpperCase()}
    </span>
  )
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
.dshc-logo-fallback{display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:50%;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-weight:500;line-height:1}
.dshc-card-title{display:flex;flex-direction:column;min-width:0}
.dshc-card-title strong{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshc-card-title span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshc-summary{display:-webkit-box;margin:0;min-height:36px;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshc-card-error{display:-webkit-box;margin:0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
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
.dshc-card-action-connect.dshc-card-action-loading{opacity:1;pointer-events:auto;cursor:progress;border-color:transparent;background:transparent;box-shadow:none}
.dshc-card:hover .dshc-card-action-connect.dshc-card-action-loading,.dshc-card:focus-within .dshc-card-action-connect.dshc-card-action-loading{opacity:1;pointer-events:auto;cursor:progress}
.dshc-spinner{display:inline-block;width:16px;height:16px;flex:none;transform-origin:50% 50%;animation:dshc-spin .8s linear infinite}
@keyframes dshc-spin{to{transform:rotate(360deg)}}
.dshc-card-action-connected{color:var(--dsw-alias-state-success-primary)}
.dshc-card-action-disabled{color:var(--dsw-alias-label-tertiary)}
.dshc-card-action-error{color:var(--dsw-alias-state-error-primary)}
.dshc-card-auth-actions{display:flex;align-items:center;gap:4px;flex:none}
.dshc-card-auth{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.dshc-spinner-inline{width:12px;height:12px}
.dshc-card-auth:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshc-card-auth:disabled{opacity:.4;cursor:not-allowed}
.dshc-card-auth:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshc-card-installed{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:.5px solid var(--dsw-alias-border-l3);border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);box-shadow:0 1px 2px color-mix(in srgb,#000 6%,transparent)}
.dshc-card-actions{display:flex;align-items:center;flex:none}
.dshc-card-toggle{display:inline-flex;align-items:center;justify-content:center;width:28px;height:16px;flex:none}
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
.dshc-card-install-actions{position:relative;display:flex;align-items:center;flex:none}
.dshc-card-more-wrap.dshc-card-more-float{position:absolute;right:32px;top:0;opacity:0;pointer-events:none;transition:opacity .15s}
.dshc-card:hover .dshc-card-more-float,.dshc-card:focus-within .dshc-card-more-float,.dshc-card-menu-open .dshc-card-more-float{opacity:1;pointer-events:auto}
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
.dshc-dock-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none;border-radius:50%;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1))}
.dshc-dock-single .dshc-dock-icon{width:24px;height:24px}
.dshc-dock-icon+.dshc-dock-icon{margin-left:-7px}
.dshc-dock-icon .dshc-logo-img{border-radius:50%}
.dshc-dock-dot{position:absolute;right:0;bottom:0;z-index:2;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}
.dshc-dock-more{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-left:2px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:500;flex:none}
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
.dshc-dock-toggle{display:inline-flex;align-items:center;justify-content:center;width:28px;height:16px;flex:none}
.dshc-dock-connect{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dshc-dock-connect:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshc-dock-connect:disabled{opacity:.4;cursor:not-allowed}
.dshc-dock-empty{padding:16px 8px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshc-dock-error{padding:4px 6px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dshc-dock-manage{display:flex;align-items:center;gap:6px;height:32px;margin-top:4px;padding:0 8px;border:0;border-top:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;flex:none}
.dshc-dock-manage:hover{color:var(--dsw-alias-label-primary)}
.dshc-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dshc-overlay-behind{background:transparent;backdrop-filter:none}
.dshc-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);max-height:min(800px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent)}
.dshc-dialog-detail,.dshc-dialog-wide{width:min(560px,100%)}
.dshc-dialog-credential{width:min(460px,100%)}
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
.dshc-field-control{position:relative;display:block}
.dshc-field-control input{width:100%;padding-right:40px}
.dshc-field-reveal{position:absolute;top:50%;right:6px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshc-field-reveal:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshc-field-reveal:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshc-field input::placeholder{color:var(--dsw-alias-label-caption)}
.dshc-field input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dshc-field textarea{box-sizing:border-box;min-height:180px;max-height:320px;padding:10px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:12px/18px var(--dsw-font-markdown-code-font-family);outline:none;resize:vertical}
.dshc-field textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dshc-field textarea.dshc-examples-input{min-height:72px;max-height:120px;padding:8px 12px;font:inherit;font-size:13px;line-height:20px}
.dshc-field-label{display:flex;align-items:center;gap:4px}
.dshc-help-btn{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshc-help-btn:hover,.dshc-help-btn:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);outline:none}
.dshc-select{position:relative}
.dshc-select-control{position:relative;display:flex;align-items:center}
.dshc-select-control input{width:100%;padding-right:36px}
.dshc-select-toggle{position:absolute;top:50%;right:4px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshc-select-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshc-select-menu{position:absolute;top:calc(100% + 4px);right:0;left:0;z-index:30;display:flex;flex-direction:column;max-height:220px;padding:4px;overflow-y:auto;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.dshc-select-menu-portal{position:fixed;right:auto;z-index:1100;box-sizing:border-box}
.dshc-select-item{display:flex;align-items:center;width:100%;height:32px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dshc-select-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshc-select-item-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary)}
.dshc-help-tip{display:flex;flex-direction:column;gap:6px;max-width:min(380px,calc(100vw - 32px));max-height:none;padding:10px 12px;overflow:visible;white-space:normal;pointer-events:auto;user-select:text;cursor:auto}
.dshc-help-tip strong{font-weight:500}
.dshc-help-tip code{display:block;padding:6px 8px;border-radius:var(--dsw-radius-sm);background:rgba(255,255,255,.12);color:inherit;font:12px/18px var(--dsw-font-markdown-code-font-family);white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden}
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
