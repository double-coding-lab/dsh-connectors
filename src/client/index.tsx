import type { Context } from '@deepseek-ai/cordis'
import type * as MonacoApi from 'monaco-editor'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import { CLI_EN, CLI_ITEM_EN } from './cli-en.js'
import type { LocaleFace } from './i18n.js'
import { bindLocale, currentLocale, progressText, tr, useLocaleRevision } from './i18n.js'

import type { CatalogPayload, CliConnectorPayload, CliConnectorView, CliListPayload, CliLogPayload, ConnectionView, ConnectorCard, ConnectionsPayload, CustomConfigPayload, CustomConfigView, CustomConnectorsPayload, CustomUpdatePayload, OAuthStartPayload, OAuthStatusPayload, ToolInfo } from '../shared/types.js'
import { ROUTE_PREFIX } from '../shared/types.js'
import { CLI_ICONS } from './cli-icons.generated.js'
import { IconAlert, IconCheck, IconChevronDown, IconClose, IconCopy, IconEye, IconEyeOff, IconHelp, IconLink, IconMore, IconPencil, IconPlay, IconPlug, IconPlus, IconRefresh, IconSearch, IconServer, IconTrash } from './icons.js'
import { PROVIDER_ICONS } from './provider-icons.generated.js'
import { BUILTIN_CATEGORIES, canonicalizeCardCategories, parseExampleLines } from '../shared/categories.js'
import { CUSTOM_SECRET_PLACEHOLDER } from '../shared/customConfig.js'

export const inject: string[] = ['locale']

const PANEL_ID = 'dsh-connectors'
const STYLE_ID = 'dsh-connectors-style'
const PROBE_ROUNDS = 6
const PROBE_INTERVAL_MS = 350

function customSummary(card: ConnectorCard): string {
  return tr(card.server.transport === 'stdio'
    ? '通过 mcpServers 导入的本地 stdio MCP Server。'
    : card.server.transport === 'sse'
      ? '通过 mcpServers 导入的 SSE MCP Server。'
      : '通过 mcpServers 导入的 Streamable HTTP MCP Server。')
}

function localizedCard(card: ConnectorCard): ConnectorCard {
  const english = currentLocale().toLowerCase().startsWith('en')
  if (card.source === 'custom') {
    const copy = english ? card.translations?.en : undefined
    const description = copy?.description ?? card.description
    return {
      ...card,
      vendor: tr('自定义'),
      summary: description ?? customSummary(card),
      ...(description === undefined ? {} : { description }),
      examples: copy?.examples ?? card.examples,
      categoryLabel: english ? copy?.category ?? card.category : card.category,
    }
  }
  if (!english) return { ...card, categoryLabel: card.category }
  const copy = card.translations?.en
  return {
    ...card,
    name: copy?.name ?? card.name,
    vendor: copy?.vendor ?? card.vendor,
    summary: copy?.summary ?? card.summary,
    description: copy?.description ?? card.description,
    examples: copy?.examples ?? card.examples,
    categoryLabel: tr(card.category),
  }
}

function localizedCli(connector: CliConnectorView): CliConnectorView {
  if (currentLocale().toLowerCase().startsWith('zh')) return connector
  const copy = CLI_EN[connector.id]
  const capabilities = connector.capabilities === undefined
    ? undefined
    : {
        ...connector.capabilities,
        items: connector.capabilities.items.map(item => {
          const translated = CLI_ITEM_EN[`${connector.id}:${item.id}`]
          return translated === undefined ? item : { ...item, ...translated }
        }),
      }
  return {
    ...connector,
    name: copy?.name ?? connector.name,
    vendor: copy?.vendor ?? connector.vendor,
    description: copy?.description ?? connector.description,
    examples: copy?.examples ?? connector.examples,
    installHint: copy?.installLabels ?? connector.installHint,
    ...(capabilities === undefined ? {} : { capabilities }),
  }
}
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
const MCP_SERVERS_PLACEHOLDER_EN = `{
  "mcpServers": {
    "my-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." },
      "x-dsh": {
        "description": "Inspect repository structure and docs",
        "category": "Search & knowledge",
        "examples": ["Use my-server to look up the latest docs"]
      }
    }
  }
}`
const X_DSH_SAMPLE_EN = `"x-dsh": {
  "description": "Inspect repository structure and docs",
  "category": "Search & knowledge",
  "examples": ["Use DeepWiki to inspect the facebook/react repository structure"],
  "translations": {
    "zh": {
      "description": "查询仓库结构与文档",
      "category": "知识检索",
      "examples": ["用 DeepWiki 查 facebook/react 的仓库结构"]
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
  try {
    return applyInner(ctx)
  } catch (error) {
    console.error('[dsh-connectors] apply failed', error)
    throw error
  }
}

function applyInner(ctx: Context): () => void {
  installStyles()
  const get = (ctx as Context & { get?: (name: string) => unknown }).get?.bind(ctx)
  bindLocale((ctx as Context & { locale?: LocaleFace }).locale)
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const startTrial = (prompt: string): void => {
    const workspace = get?.('uiWorkspace') as WorkspaceFace | undefined
    if (workspace === undefined || typeof workspace.startSession !== 'function') {
      throw new Error(tr('当前 DSH 版本不支持从连接器打开会话'))
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
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => tr('连接器') }, PanelIcon))
      console.info('[dsh-connectors] panel registered')
    } catch (error) {
      console.error('[dsh-connectors] panel registration failed', error)
    }

    try {
      slots.inject('conversation.input.left', () =>
        slots.register({ name: 'conversation.input.left', id: `${PANEL_ID}-dock`, order: 20, label: () => tr('连接器') }, ConnectorDock))
    } catch (error) {
      console.warn('[dsh-connectors] composer dock slot unavailable', error)
    }

    try {
      slots.inject('conversation.input.overlay', () =>
        slots.register({ name: 'conversation.input.overlay', id: `${PANEL_ID}-popover`, order: 20, label: () => tr('连接器') }, ConnectorPopover))
    } catch (error) {
      console.warn('[dsh-connectors] composer overlay slot unavailable', error)
    }

    try {
      slots.inject('shell.overlay', () =>
        slots.register({ name: 'shell.overlay', id: `${PANEL_ID}-flow`, order: 20, label: () => tr('连接器弹窗') }, () => <Panel startTrial={startTrial} variant="overlay" />))
    } catch (error) {
      console.warn('[dsh-connectors] shell overlay slot unavailable', error)
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
  variant?: 'panel' | 'overlay'
}

function promptForExample(card: ConnectorCard, example: string): string {
  return example.toLowerCase().includes(card.name.toLowerCase()) ? example : tr("使用 {v0}：{v1}", { v0: card.name, v1: example })
}

function promptForNextExample(card: ConnectorCard): string {
  const examples = card.examples ?? []
  if (examples.length === 0) return tr("使用 {v0} 的工具完成一个简单任务，先列出可用工具。", { v0: card.name })
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
  return auth.type === 'bearer' || auth.type === 'header' ? auth.label : tr('访问令牌')
}

function instanceNoun(card: ConnectorCard): string {
  return card.instance?.noun ?? tr('地址')
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

function ToolRow({ name, description }: { name: string; description?: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const descRef = useRef<HTMLParagraphElement>(null)

  useLayoutEffect(() => {
    const element = descRef.current
    if (element === null || description === undefined) {
      setOverflow(false)
      return
    }
    if (expanded) return
    const measure = (): void => {
      setOverflow(element.scrollHeight > element.clientHeight + 1)
    }
    measure()
    const frame = window.requestAnimationFrame(measure)
    return () => window.cancelAnimationFrame(frame)
  }, [description, expanded])

  return (
    <div className="dshc-tool">
      <div className="dshc-tool-head">
        <code>{name}</code>
        {overflow && (
          <button
            type="button"
            className="dshc-tool-expand"
            aria-label={expanded ? tr('收起描述') : tr('展开描述')}
            aria-expanded={expanded}
            title={expanded ? tr('收起描述') : tr('展开描述')}
            onClick={() => setExpanded(current => !current)}
          >
            <IconChevronDown
              size={14}
              className={expanded ? 'dshc-tool-chevron dshc-tool-chevron-expanded' : 'dshc-tool-chevron'}
            />
          </button>
        )}
      </div>
      {description !== undefined && (
        <p ref={descRef} className={expanded ? 'dshc-tool-desc-expanded' : undefined}>{description}</p>
      )}
    </div>
  )
}

type Monaco = typeof MonacoApi
type MonacoEditorInstance = MonacoApi.editor.IStandaloneCodeEditor
type MonacoDisposable = MonacoApi.IDisposable

interface MonacoAmdRequire {
  (deps: string[], callback: () => void): void
  config(options: { paths: Record<string, string> }): void
}

declare global {
  interface Window {
    monaco?: Monaco
    require?: MonacoAmdRequire
  }
}

let monacoPromise: Promise<Monaco> | null = null

function loadMonaco(): Promise<Monaco> {
  if (window.monaco !== undefined) return Promise.resolve(window.monaco)
  if (monacoPromise !== null) return monacoPromise

  const load = new Promise<Monaco>((resolve, reject) => {
    const start = (): void => {
      const amd = window.require
      if (amd === undefined) {
        reject(new Error('Monaco AMD loader unavailable'))
        return
      }
      try {
        amd.config({ paths: { vs: `${ROUTE_PREFIX}/api/monaco/vs` } })
        amd(['vs/editor/editor.main'], () => {
          if (window.monaco !== undefined) resolve(window.monaco)
          else reject(new Error('Monaco editor unavailable'))
        })
      } catch (error) {
        reject(error)
      }
    }

    if (window.require !== undefined) {
      start()
      return
    }
    const script = document.createElement('script')
    script.src = `${ROUTE_PREFIX}/api/monaco/vs/loader.js`
    script.async = true
    script.onload = start
    script.onerror = () => reject(new Error('Monaco loader failed to load'))
    document.head.appendChild(script)
  })

  monacoPromise = Promise.race([
    load,
    new Promise<Monaco>((_, reject) => {
      window.setTimeout(() => reject(new Error('Monaco editor load timeout')), 15_000)
    }),
  ])
  monacoPromise.catch(() => {
    monacoPromise = null
  })
  return monacoPromise
}

function JsonEditor({ value, onChange }: { value: string; onChange: (value: string) => void }): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MonacoEditorInstance | null>(null)
  const subscriptionRef = useRef<MonacoDisposable | null>(null)
  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  onChangeRef.current = onChange
  valueRef.current = value

  useEffect(() => {
    let active = true
    void loadMonaco().then(monaco => {
      if (!active || mountRef.current === null) return
      const editor = monaco.editor.create(mountRef.current, {
        value: valueRef.current,
        language: 'json',
        theme: 'vs',
        ariaLabel: 'mcpServers JSON',
        automaticLayout: true,
        minimap: { enabled: false },
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        folding: true,
        glyphMargin: false,
        lineDecorationsWidth: 10,
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: false,
        fontSize: 12,
        lineHeight: 18,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        padding: { top: 10, bottom: 10 },
        renderLineHighlight: 'line',
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        contextmenu: false,
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        fixedOverflowWidgets: true,
        renderValidationDecorations: 'on',
        bracketPairColorization: { enabled: true },
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
      })
      editorRef.current = editor
      subscriptionRef.current = editor.onDidChangeModelContent(() => {
        onChangeRef.current(editor.getValue())
      })
      setReady(true)
      editor.focus()
    }).catch(() => {
      if (active) setFailed(true)
    })

    return () => {
      active = false
      subscriptionRef.current?.dispose()
      subscriptionRef.current = null
      editorRef.current?.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (editor !== null && editor.getValue() !== value) editor.setValue(value)
  }, [value])

  return (
    <div className="dshc-json-editor">
      <div ref={mountRef} className="dshc-json-editor-mount" />
      {!ready && (
        <textarea
          autoFocus
          className="dshc-json-editor-fallback"
          aria-label="mcpServers JSON"
          spellCheck={false}
          value={value}
          onChange={event => onChange(event.target.value)}
        />
      )}
      {!ready && !failed && (
        <div className="dshc-json-editor-loading">
          <Spinner inline />
          
          {tr("正在加载编辑器…")}
        </div>
      )}
    </div>
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError('oauth_cancelled', tr('已取消授权')))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ApiError('oauth_cancelled', tr('已取消授权')))
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

function oauthRedirectUri(card: ConnectorCard): string {
  const url = new URL(`${window.location.origin}${ROUTE_PREFIX}/api/oauth/callback`)
  // 百度等厂商要求回调使用域名，不接受 IP；本机访问时改用 localhost
  const needsDomain = card.auth.type === 'oauth2' && card.auth.registration === 'user'
  if (needsDomain && (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]')) {
    url.hostname = 'localhost'
  }
  return url.toString()
}

async function authorizeConnector(
  card: ConnectorCard,
  options: { signal?: AbortSignal; onFlow?: (flow: OAuthFlowInfo) => void } = {},
): Promise<ConnectionView> {
  const redirectUri = oauthRedirectUri(card)
  let response: OAuthStartPayload
  try {
    response = await request<OAuthStartPayload>(`${ROUTE_PREFIX}/api/oauth/start`, {
      method: 'POST',
      body: JSON.stringify({ connectorId: card.id, redirectUri }),
      signal: options.signal,
    })
  } catch (cause) {
    if (options.signal?.aborted) throw new ApiError('oauth_cancelled', tr('已取消授权'))
    throw cause
  }
  const { flowId, authorizeUrl, opened } = response.value
  options.onFlow?.({ flowId, authorizeUrl, opened })
  if (options.signal?.aborted) throw new ApiError('oauth_cancelled', tr('已取消授权'))

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
      if (options.signal?.aborted) throw new ApiError('oauth_cancelled', tr('已取消授权'))
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
        if (options.signal?.aborted) throw new ApiError('oauth_cancelled', tr('已取消授权'))
      }
      if (fetched) {
        if (connection === undefined) {
          throw new ApiError('oauth_failed', tr('授权完成，但没有找到连接记录，请刷新面板重试'))
        }
        return connection
      }
    }
    if (status?.status === 'error') {
      throw new ApiError('oauth_failed', status.message ?? tr('授权失败，请重试'))
    }
    if (status?.status === 'expired') {
      throw new ApiError('oauth_expired', tr('授权已过期，请重试'))
    }
    if (Date.now() >= deadline) {
      await request(`${ROUTE_PREFIX}/api/oauth/cancel`, {
        method: 'POST',
        body: JSON.stringify({ flowId }),
      }).catch(() => undefined)
      throw new ApiError('oauth_timeout', tr('授权超时，请重试'))
    }
  }
}

async function saveOAuthClient(card: ConnectorCard, clientId: string, clientSecret: string): Promise<ConnectionView> {
  const response = await request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections/${encodeURIComponent(card.id)}/oauth-client`, {
    method: 'POST',
    body: JSON.stringify({ clientId, clientSecret }),
  })
  const connection = response.value?.connection
  if (connection === undefined) throw new ApiError('invalid_response', tr('保存应用凭据失败：宿主没有返回连接'))
  return connection
}

interface DockSnapshot {
  open: boolean
  cards: ConnectorCard[]
  connections: Record<string, ConnectionView>
  cli: CliConnectorView[]
  loaded: boolean
  loading: boolean
  error: string | null
  query: string
  pendingId: string | null
  cliPendingId: string | null
}

const initialDockSnapshot: DockSnapshot = {
  open: false,
  cards: [],
  connections: {},
  cli: [],
  loaded: false,
  loading: false,
  error: null,
  query: '',
  pendingId: null,
  cliPendingId: null,
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
      const [catalog, list, cli] = await Promise.all([
        request<CatalogPayload>(`${ROUTE_PREFIX}/api/catalog`),
        request<ConnectionsPayload>(`${ROUTE_PREFIX}/api/connections`),
        request<CliListPayload>(`${ROUTE_PREFIX}/api/cli`).catch(() => null),
      ])
      updateDock({
        cards: catalog.value.cards,
        connections: Object.fromEntries(list.value.connections.map(item => [item.connectorId, item])),
        cli: cli?.value.connectors ?? [],
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
  if (!dockSnapshot.open && dockSnapshot.pendingId === null) return
  updateDock({ open: false, query: '', error: null, pendingId: null, cliPendingId: null })
}

function toggleDock(): void {
  if (dockSnapshot.open) closeDock()
  else updateDock({ open: true, error: null })
}

let flowRequest: string | null = null
let cliFlowRequest: { id: string; action: 'install' | 'login' } | null = null

function requestCliFlow(id: string, action: 'install' | 'login'): void {
  cliFlowRequest = { id, action }
  window.dispatchEvent(new Event('dshc:cli-flow-request'))
}

function announceCliFlowOpened(id: string): void {
  window.dispatchEvent(new CustomEvent('dshc:cli-flow-opened', { detail: { id } }))
}

function requestConnectorFlow(cardId: string): void {
  flowRequest = cardId
  window.dispatchEvent(new Event('dshc:flow-request'))
}

function announceConnectorFlow(cardId: string): void {
  window.dispatchEvent(new CustomEvent('dshc:flow-opened', { detail: { cardId } }))
}

function announceConnectorFlowStarted(cardId: string): void {
  window.dispatchEvent(new CustomEvent('dshc:flow-started', { detail: { cardId } }))
}

function announceConnectorFlowFinished(cardId: string): void {
  window.dispatchEvent(new CustomEvent('dshc:flow-finished', { detail: { cardId } }))
}

function requestConnectorFlowCancel(cardId: string): void {
  window.dispatchEvent(new CustomEvent('dshc:flow-cancel', { detail: { cardId } }))
}

function announceConnectorFlowError(cardId: string, message: string): void {
  window.dispatchEvent(new CustomEvent('dshc:flow-error', { detail: { cardId, message } }))
}

function dockCardRank(card: ConnectorCard, connections: DockSnapshot['connections']): number {
  const connection = connections[card.id]
  if (connection === undefined) return 3
  if (!connection.authorized) return 2
  return connection.enabled ? 0 : 1
}

function cliDockRank(connector: CliConnectorView): number {
  if (!connector.installed) return 3
  if (!connector.authenticated) return 2
  return connector.enabled !== false ? 0 : 1
}

function compareDockCards(
  left: ConnectorCard,
  right: ConnectorCard,
  connections: DockSnapshot['connections'],
): number {
  return dockCardRank(left, connections) - dockCardRank(right, connections)
    || left.name.localeCompare(right.name, 'zh-CN')
    || left.id.localeCompare(right.id)
}

function enabledDockCards(state: DockSnapshot): ConnectorCard[] {
  return state.cards
    .filter(card => {
      const connection = state.connections[card.id]
      return connection !== undefined && connection.enabled && connection.authorized
    })
    .sort((left, right) => compareDockCards(left, right, state.connections))
}

function enabledDockCli(state: DockSnapshot): CliConnectorView[] {
  return state.cli
    .filter(connector => connector.installed && connector.authenticated && connector.enabled !== false)
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
}

function dockActionLabel(card: ConnectorCard, connection?: ConnectionView): string {
  if (connection === undefined) return tr('安装')
  if (card.instance !== undefined && connection.instanceReady !== true) return tr('配置')
  return tr('授权')
}

function openConnectorPanel(): void {
  closeDock()
  if (document.querySelector('.dshc-root:not(.dshc-flow-root)') !== null) return
  const button = Array.from(document.querySelectorAll('button')).find(item => {
    const label = item.getAttribute('aria-label')
    return label === '连接器' || label === tr('连接器')
  })
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

async function toggleDockCli(connector: CliConnectorView, enabled: boolean): Promise<void> {
  updateDock({ cliPendingId: connector.id })
  try {
    await request(`${ROUTE_PREFIX}/api/cli/${encodeURIComponent(connector.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  } catch {
    // 失败保留原状态，刷新后由 API 状态兜底
  } finally {
    await refreshDock()
    updateDock({ cliPendingId: null })
  }
}

async function cancelDockCli(connector: CliConnectorView): Promise<void> {
  updateDock({ cliPendingId: connector.id })
  try {
    await request(`${ROUTE_PREFIX}/api/cli/${encodeURIComponent(connector.id)}/cancel`, { method: 'POST' })
  } catch {
    // 取消失败由刷新后的阶段状态兜底
  } finally {
    await refreshDock()
    updateDock({ cliPendingId: null })
  }
}

function ConnectorDock(): JSX.Element | null {
  useLocaleRevision()
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
  const cli = enabledDockCli(state)
  if (cards.length === 0 && cli.length === 0) return null
  const entries = [
    ...cards.map(card => ({ kind: 'mcp' as const, id: card.id, name: card.name, card, failed: state.connections[card.id]?.error !== undefined })),
    ...cli.map(connector => ({ kind: 'cli' as const, id: connector.id, name: connector.name, connector, failed: connector.phase === 'error' })),
  ].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  const shown = entries.slice(0, 3)
  const extra = entries.length - shown.length
  const label = entries
    .map(entry => `${entry.name}${entry.failed ? tr('（连接失败）') : ''}`)
    .join('、')
  const single = entries.length === 1

  return (
    <button
      type="button"
      className={single ? 'dshc-dock dshc-dock-single' : 'dshc-dock'}
      data-dshc-dock="true"
      title={label}
      aria-label={tr("已启用 {v0} 个连接器", { v0: entries.length })}
      onClick={toggleDock}
    >
      {shown.map((entry, index) => (
        <span key={`${entry.kind}:${entry.id}`} className="dshc-dock-icon" style={{ zIndex: shown.length - index }}>
          {entry.kind === 'mcp'
            ? <ConnectorLogo card={entry.card} size={single ? 24 : 18} />
            : <CliLogo connector={entry.connector} size={single ? 24 : 18} />}
          {entry.failed && <span className="dshc-dock-dot" />}
        </span>
      ))}
      {extra > 0 && <span className="dshc-dock-more">+{extra}</span>}
    </button>
  )
}

function ConnectorPopover(): JSX.Element | null {
  useLocaleRevision()
  const state = useDock()
  const [tip, setTip] = useState<{ text: string; left: number; top: number; width: number } | null>(null)
  const [pendingLabel, setPendingLabel] = useState<string | null>(null)
  const flowAckRef = useRef<string | null>(null)
  const cliWasActiveRef = useRef(false)

  useEffect(() => {
    setTip(null)
  }, [state.open, state.query])

  useEffect(() => {
    const onStarted = (event: Event): void => {
      const cardId = (event as CustomEvent<{ cardId?: string }>).detail?.cardId
      if (cardId !== undefined) flowAckRef.current = cardId
    }
    const onOpened = (event: Event): void => {
      const cardId = (event as CustomEvent<{ cardId?: string }>).detail?.cardId
      if (cardId !== undefined && dockSnapshot.pendingId !== null && dockSnapshot.pendingId !== cardId) return
      updateDock({ pendingId: null })
      setPendingLabel(null)
    }
    const onAuthorizing = (event: Event): void => {
      const cardId = (event as CustomEvent<{ cardId?: string }>).detail?.cardId
      if (cardId !== undefined && dockSnapshot.pendingId === cardId) setPendingLabel('授权')
    }
    const onFinished = (event: Event): void => {
      if (dockSnapshot.pendingId === null) return
      const cardId = (event as CustomEvent<{ cardId?: string }>).detail?.cardId
      if (cardId !== undefined && dockSnapshot.pendingId !== cardId) return
      updateDock({ pendingId: null })
      setPendingLabel(null)
      void refreshDock()
    }
    const onError = (event: Event): void => {
      const detail = (event as CustomEvent<{ cardId?: string; message?: string }>).detail
      if (detail?.cardId === undefined || dockSnapshot.pendingId !== detail.cardId) return
      updateDock({ error: detail.message ?? null })
    }
    const onCliOpened = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id !== undefined && dockSnapshot.cliPendingId !== null && dockSnapshot.cliPendingId !== id) return
      updateDock({ cliPendingId: null })
      void refreshDock()
    }
    window.addEventListener('dshc:flow-started', onStarted)
    window.addEventListener('dshc:flow-opened', onOpened)
    window.addEventListener('dshc:flow-authorizing', onAuthorizing)
    window.addEventListener('dshc:flow-finished', onFinished)
    window.addEventListener('dshc:flow-error', onError)
    window.addEventListener('dshc:cli-flow-opened', onCliOpened)
    return () => {
      window.removeEventListener('dshc:flow-started', onStarted)
      window.removeEventListener('dshc:flow-opened', onOpened)
      window.removeEventListener('dshc:flow-authorizing', onAuthorizing)
      window.removeEventListener('dshc:flow-finished', onFinished)
      window.removeEventListener('dshc:flow-error', onError)
      window.removeEventListener('dshc:cli-flow-opened', onCliOpened)
    }
  }, [])

  useEffect(() => {
    if (state.open) void refreshDock()
  }, [state.open])

  const cliActive = state.cli.some(connector => connector.phase !== 'idle' && connector.phase !== 'error')
  useEffect(() => {
    if (!state.open) return
    if (cliActive) {
      cliWasActiveRef.current = true
      const timer = window.setInterval(() => {
        void refreshDock()
      }, 1200)
      return () => window.clearInterval(timer)
    }
    if (!cliWasActiveRef.current) return
    cliWasActiveRef.current = false
    const timer = window.setTimeout(() => { void refreshDock() }, 900)
    return () => window.clearTimeout(timer)
  }, [state.open, cliActive])

  useEffect(() => {
    if (!state.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('.dshc-overlay .dshc-dialog') !== null) return
      closeDock()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-dshc-dock],.dshc-dock-popover,.dshc-overlay,.dshc-dialog,.dshc-card-tip') === null) closeDock()
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
    .sort((left, right) => compareDockCards(left, right, state.connections))
  const cli = state.cli
    .filter(connector => keyword === ''
      || `${connector.name} CLI ${connector.vendor} ${connector.description} ${connector.examples.join(' ')}`.toLowerCase().includes(keyword))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

  const showRowTip = (element: HTMLElement, text: string): void => {
    if (text.trim() === '') return
    const rect = element.getBoundingClientRect()
    const width = Math.min(320, window.innerWidth - 32)
    let left = rect.right + 10
    if (left + width > window.innerWidth - 16) left = Math.max(16, rect.left - width - 10)
    const top = Math.max(16, Math.min(rect.top, window.innerHeight - 200))
    setTip({ text, left, top, width })
  }

  const startFlow = (card: ConnectorCard): void => {
    flowAckRef.current = null
    setTip(null)
    setPendingLabel(dockActionLabel(card, state.connections[card.id]))
    updateDock({ pendingId: card.id, error: null })
    requestConnectorFlow(card.id)
    window.setTimeout(() => {
      if (dockSnapshot.pendingId !== card.id || flowAckRef.current === card.id) return
      updateDock({ pendingId: null })
      openConnectorPanel()
    }, 1500)
  }

  const startCliFlow = (connector: CliConnectorView, action: 'install' | 'login'): void => {
    setTip(null)
    updateDock({ cliPendingId: connector.id, error: null })
    requestCliFlow(connector.id, action)
    window.setTimeout(() => {
      if (dockSnapshot.cliPendingId !== connector.id) return
      updateDock({ cliPendingId: null })
      openConnectorPanel()
    }, 1500)
  }

  const rows = [
    ...cards.map(card => ({
      kind: 'mcp' as const,
      id: card.id,
      name: card.name,
      rank: dockCardRank(card, state.connections),
      card,
    })),
    ...cli.map(connector => ({
      kind: 'cli' as const,
      id: connector.id,
      name: connector.name,
      rank: cliDockRank(connector),
      connector,
    })),
  ].sort((left, right) => left.rank - right.rank
    || left.name.localeCompare(right.name, 'zh-CN')
    || left.id.localeCompare(right.id))

  const renderMcpRow = (card: ConnectorCard): JSX.Element => {
    const connection = state.connections[card.id]
    const pending = state.pendingId === card.id
    const actionLabel = dockActionLabel(card, connection)
    const pendingLabelText = pendingLabel ?? actionLabel
    const canCancel = isOAuthCard(card) || isTokenCard(card) || card.instance !== undefined
    return (
      <div className="dshc-dock-item" key={card.id}>
        <div
          className="dshc-dock-row"
          onMouseEnter={event => showRowTip(event.currentTarget, card.description ?? card.summary)}
          onMouseLeave={() => setTip(null)}
        >
          <span className="dshc-dock-row-icon"><ConnectorLogo card={card} size={18} /></span>
          <span className="dshc-dock-row-main">
            <span className="dshc-dock-row-name">{card.name}</span>
            {connection?.error !== undefined && (
              <span className="dshc-dock-row-error" title={connection.error}>{tr("连接失败")}</span>
            )}
          </span>
          {connection !== undefined && connection.authorized
            ? (
                pending
                  ? <span className="dshc-dock-toggle" role="status" aria-label={tr("处理中")}>
                      <Spinner inline />
                    </span>
                  : <button
                      type="button"
                      role="switch"
                      className="dshc-switch"
                      aria-checked={connection.enabled}
                      aria-label={connection.enabled ? tr("停用 {v0}", { v0: card.name }) : tr("启用 {v0}", { v0: card.name })}
                      title={connection.enabled ? tr('停用') : tr('启用')}
                      onClick={() => { void toggleDockConnection(card, !connection.enabled) }}
                    />
              )
            : (
                pending
                  ? <span className="dshc-dock-pending" role="status" aria-label={progressText(pendingLabelText)}>
                      <Spinner inline />
                      {progressText(pendingLabelText)}
                      {canCancel && (
                        <button
                          type="button"
                          className="dshc-dock-pending-cancel"
                          onClick={event => {
                            event.stopPropagation()
                            requestConnectorFlowCancel(card.id)
                          }}
                        >
                          
                          {tr("取消")}
                        </button>
                      )}
                    </span>
                  : <button type="button" className="dshc-dock-connect" onClick={() => startFlow(card)}>
                      <IconLink size={13} />
                      {actionLabel}
                    </button>
              )}
        </div>
      </div>
    )
  }

  const renderCliRow = (connector: CliConnectorView): JSX.Element => {
    const busy = connector.phase === 'installing'
      || connector.phase === 'updating'
      || connector.phase === 'configuring'
      || connector.phase === 'logging_in'
      || connector.phase === 'uninstalling'
    const pending = state.cliPendingId === connector.id || busy
    const enabled = connector.enabled !== false
    const ready = connector.installed && connector.authenticated
    const action = connector.installed ? 'login' : 'install'
    const actionLabel = connector.installed ? tr('登录') : tr('安装')
    const pendingLabel = connector.stage ?? actionLabel
    return (
      <div className="dshc-dock-item" key={`cli:${connector.id}`}>
        <div
          className="dshc-dock-row"
          onMouseEnter={event => showRowTip(event.currentTarget, connector.description)}
          onMouseLeave={() => setTip(null)}
        >
          <span className="dshc-dock-row-icon"><CliLogo connector={connector} size={18} /></span>
          <span className="dshc-dock-row-main">
            <span className="dshc-dock-row-name">{connector.name}</span>
            {connector.phase === 'error' && connector.lastError !== undefined && (
              <span className="dshc-dock-row-error" title={connector.lastError}>{tr("处理失败")}</span>
            )}
          </span>
          <span className="dshc-dock-row-hint">CLI</span>
          {ready && !busy
            ? (
                pending
                  ? <span className="dshc-dock-toggle" role="status" aria-label={tr("处理中")}>
                      <Spinner inline />
                    </span>
                  : <button
                      type="button"
                      role="switch"
                      className="dshc-switch"
                      aria-checked={enabled}
                      aria-label={enabled ? tr("停用 {v0}", { v0: connector.name }) : tr("启用 {v0}", { v0: connector.name })}
                      title={enabled ? tr('停用') : tr('启用')}
                      onClick={() => { void toggleDockCli(connector, !enabled) }}
                    />
              )
            : (
                pending
                  ? <span className="dshc-dock-pending" role="status" aria-label={progressText(pendingLabel)}>
                      <Spinner inline />
                      {progressText(pendingLabel)}
                      <button
                        type="button"
                        className="dshc-dock-pending-cancel"
                        onClick={event => {
                          event.stopPropagation()
                          void cancelDockCli(connector)
                        }}
                      >
                        
                        {tr("取消")}
                      </button>
                    </span>
                  : <button type="button" className="dshc-dock-connect" onClick={() => startCliFlow(connector, action)}>
                      <IconLink size={13} />
                      {actionLabel}
                    </button>
              )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="dshc-dock-popover" role="dialog" aria-label={tr("连接器")}>
      <label className="dshc-dock-search">
        <IconSearch size={13} />
        <input
          autoFocus
          name="dsh-connector-dock-search"
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          data-bwignore="true"
          placeholder={tr('搜索连接器')}
          value={state.query}
          onChange={event => updateDock({ query: event.target.value })}
        />
      </label>
      <div className="dshc-dock-list" onScroll={() => setTip(null)}>
        {!state.loaded
          ? <div className="dshc-dock-empty">{state.loading ? tr('正在加载连接器…') : tr('没有可用的连接器')}</div>
          : rows.length === 0
            ? <div className="dshc-dock-empty">{tr('没有匹配的连接器')}</div>
            : rows.map(entry => entry.kind === 'mcp'
              ? renderMcpRow(entry.card)
              : renderCliRow(entry.connector))}
      </div>
      {state.error !== null && <div className="dshc-dock-error">{state.error}</div>}
      <button type="button" className="dshc-dock-manage" onClick={openConnectorPanel}>
        <IconLink size={13} />
        
        {tr("管理连接器")}
      </button>
      </div>
      {tip !== null && createPortal(
        <div className="dshc-card-tip dshc-dock-tip" style={{ left: tip.left, top: tip.top, width: tip.width }}>
          {tip.text}
        </div>,
        document.body,
      )}
    </>
  )
}

function Panel({ startTrial, variant = 'panel' }: PanelProps): JSX.Element {
  const localeRevision = useLocaleRevision()
  const [cards, setCards] = useState<ConnectorCard[]>([])
  const [connections, setConnections] = useState<Record<string, ConnectionView>>({})
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [category, setCategory] = useState('全部')
  const [loading, setLoading] = useState(false)
  const [dialogCard, setDialogCard] = useState<ConnectorCard | null>(null)
  const [dialogInstall, setDialogInstall] = useState(false)
  const [credentialCard, setCredentialCard] = useState<ConnectorCard | null>(null)
  const [credentialMode, setCredentialMode] = useState<'install' | 'update'>('update')
  const [credentialSaving, setCredentialSaving] = useState<string | null>(null)
  const [credentialError, setCredentialError] = useState<{ cardId: string; message: string } | null>(null)
  const [oauthAppCard, setOauthAppCard] = useState<ConnectorCard | null>(null)
  const [oauthAppSaving, setOauthAppSaving] = useState(false)
  const [oauthAppError, setOauthAppError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [togglePending, setTogglePending] = useState<string | null>(null)
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({})
  const [oauthFlow, setOAuthFlow] = useState<(OAuthFlowInfo & { connectorId: string }) | null>(null)
  const [oauthStarting, setOauthStarting] = useState<string | null>(null)
  const oauthAbortRef = useRef<AbortController | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [deleteCard, setDeleteCard] = useState<ConnectorCard | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [instanceCard, setInstanceCard] = useState<ConnectorCard | null>(null)
  const [instanceMode, setInstanceMode] = useState<'config' | 'replace'>('config')
  const [instancePending, setInstancePending] = useState(false)
  const [instanceError, setInstanceError] = useState<string | null>(null)
  const [instanceReturnToDetail, setInstanceReturnToDetail] = useState(false)
  const [editCard, setEditCard] = useState<ConnectorCard | null>(null)
  const [editConfig, setEditConfig] = useState<CustomConfigView | null>(null)
  const [editReturnToDetail, setEditReturnToDetail] = useState(false)
  const dialogCardRef = useRef<ConnectorCard | null>(null)
  const installOpRef = useRef<{ cardId: string; kind: 'token' | 'instance'; canceled: boolean } | null>(null)
  const [flowTick, setFlowTick] = useState(0)
  const [cliConnectors, setCliConnectors] = useState<CliConnectorView[]>([])
  const [cliError, setCliError] = useState<string | null>(null)
  const [cliDetailId, setCliDetailId] = useState<string | null>(null)
  const [cliInstallId, setCliInstallId] = useState<string | null>(null)
  const [cliLoginId, setCliLoginId] = useState<string | null>(null)
  const [cliUninstallId, setCliUninstallId] = useState<string | null>(null)
  const [cliUpdateId, setCliUpdateId] = useState<string | null>(null)
  const [cliUpdateStarted, setCliUpdateStarted] = useState(false)
  const [cliUpdateError, setCliUpdateError] = useState<string | null>(null)
  const [cliUninstallPending, setCliUninstallPending] = useState(false)
  const [cliUninstallError, setCliUninstallError] = useState<string | null>(null)
  const [cliBusyId, setCliBusyId] = useState<string | null>(null)
  const [cliTogglePending, setCliTogglePending] = useState<string | null>(null)
  const [cliFlow, setCliFlow] = useState<{ id: string; action: 'install' | 'login' } | null>(null)
  const [cliErrorId, setCliErrorId] = useState<string | null>(null)

  useEffect(() => {
    dialogCardRef.current = dialogCard
  }, [dialogCard])

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

  useEffect(() => {
    const onChange = (): void => refreshConnections()
    window.addEventListener('dshc:connections-changed', onChange)
    return () => window.removeEventListener('dshc:connections-changed', onChange)
  }, [])

  const loadCli = (): void => {
    void (async () => {
      try {
        const response = await request<CliListPayload>(`${ROUTE_PREFIX}/api/cli`)
        setCliConnectors(response.value.connectors)
        setCliError(null)
      } catch (cause) {
        setCliError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }

  useEffect(loadCli, [])

  const cliActive = cliConnectors.some(connector => connector.phase !== 'idle' && connector.phase !== 'error')
  const localizedCliConnectors = useMemo(() => cliConnectors.map(localizedCli), [cliConnectors, localeRevision])
  const cliWasActiveRef = useRef(false)
  useEffect(() => {
    if (cliActive) {
      cliWasActiveRef.current = true
      const timer = window.setInterval(() => {
        void (async () => {
          try {
            const response = await request<CliListPayload>(`${ROUTE_PREFIX}/api/cli`)
            setCliConnectors(response.value.connectors)
          } catch {
            // 轮询失败保留当前状态
          }
        })()
      }, 1200)
      return () => window.clearInterval(timer)
    }
    if (!cliWasActiveRef.current) return
    cliWasActiveRef.current = false
    const timer = window.setTimeout(loadCli, 900)
    return () => window.clearTimeout(timer)
  }, [cliActive])

  useEffect(() => {
    if (variant !== 'overlay') return
    const onRequest = (): void => {
      if (cliFlowRequest !== null) {
        setCliFlow(cliFlowRequest)
        cliFlowRequest = null
      }
    }
    window.addEventListener('dshc:cli-flow-request', onRequest)
    if (cliFlowRequest !== null) onRequest()
    return () => window.removeEventListener('dshc:cli-flow-request', onRequest)
  }, [variant])

  useEffect(() => {
    if (variant !== 'overlay' || cliFlow === null) return
    const connector = localizedCliConnectors.find(item => item.id === cliFlow.id)
    if (connector === undefined) return
    const request = cliFlow
    setCliFlow(null)
    if (request.action === 'install') {
      setCliInstallId(connector.id)
    } else {
      runCliAction(connector.id, 'login')
      setCliLoginId(connector.id)
    }
    announceCliFlowOpened(connector.id)
  }, [variant, cliFlow, localizedCliConnectors])

  const applyCli = (connector: CliConnectorView): void => {
    setCliConnectors(previous => {
      const existing = previous.find(item => item.id === connector.id)
      if (
        existing?.updatedAt !== undefined
        && connector.updatedAt !== undefined
        && connector.updatedAt < existing.updatedAt
      ) {
        return previous
      }
      return existing === undefined
        ? [...previous, connector]
        : previous.map(item => (item.id === connector.id ? connector : item))
    })
  }

  const runCliAction = (id: string, action: 'install' | 'login' | 'logout' | 'cancel'): void => {
    setCliBusyId(id)
    void (async () => {
      try {
        const response = await request<CliConnectorPayload>(`${ROUTE_PREFIX}/api/cli/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
        })
        applyCli(response.value.connector)
        setCliError(null)
        if (action === 'login') setCliLoginId(id)
        if (action === 'logout') setCliLoginId(null)
        notifyConnectionsChanged()
      } catch (cause) {
        setCliError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setCliBusyId(null)
      }
    })()
  }

  const toggleCli = (connector: CliConnectorView, enabled: boolean): void => {
    setCliTogglePending(connector.id)
    void (async () => {
      try {
        const response = await request<CliConnectorPayload>(`${ROUTE_PREFIX}/api/cli/${encodeURIComponent(connector.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        })
        applyCli(response.value.connector)
        setCliError(null)
        notifyConnectionsChanged()
      } catch (cause) {
        setCliError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setCliTogglePending(current => current === connector.id ? null : current)
      }
    })()
  }

  const trialCli = (connector: CliConnectorView, example?: string): void => {
    const prompt = example !== undefined
      ? tr("使用{v0} CLI：{v1}", { v0: connector.name, v1: example })
      : connector.examples[0] !== undefined
        ? tr("使用{v0} CLI：{v1}", { v0: connector.name, v1: connector.examples[0] })
        : tr("使用 {v0} CLI 完成一个简单任务，先说明可以做什么。", { v0: connector.name })
    try {
      startTrial(prompt)
    } catch (cause) {
      setCliError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const uninstallCli = (connector: CliConnectorView): void => {
    if (cliUninstallPending) return
    setCliUninstallPending(true)
    setCliUninstallError(null)
    void (async () => {
      try {
        const response = await request<CliConnectorPayload>(
          `${ROUTE_PREFIX}/api/cli/${encodeURIComponent(connector.id)}/uninstall`,
          { method: 'POST' },
        )
        applyCli(response.value.connector)
        notifyConnectionsChanged()
      } catch (cause) {
        setCliUninstallError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setCliUninstallPending(false)
      }
    })()
  }

  const closeCliUninstall = (): void => {
    setCliUninstallId(null)
    setCliUninstallError(null)
  }

  const startCliUpdate = (connector: CliConnectorView): void => {
    setCliUpdateStarted(false)
    setCliUpdateError(null)
    void (async () => {
      try {
        const response = await request<CliConnectorPayload>(
          `${ROUTE_PREFIX}/api/cli/${encodeURIComponent(connector.id)}/update`,
          { method: 'POST' },
        )
        applyCli(response.value.connector)
        setCliUpdateStarted(true)
      } catch (cause) {
        setCliUpdateError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }

  const closeCliUpdate = (): void => {
    setCliUpdateId(null)
    setCliUpdateStarted(false)
    setCliUpdateError(null)
  }

  const cancelUninstall = (connector: CliConnectorView): void => {
    setCliUninstallPending(true)
    setCliUninstallError(null)
    void (async () => {
      try {
        const response = await request<CliConnectorPayload>(
          `${ROUTE_PREFIX}/api/cli/${encodeURIComponent(connector.id)}/cancel`,
          { method: 'POST' },
        )
        applyCli(response.value.connector)
        setCliUninstallId(null)
        notifyConnectionsChanged()
      } catch (cause) {
        setCliUninstallError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setCliUninstallPending(false)
      }
    })()
  }

  useEffect(() => {
    if (cliUninstallId === null) return
    const connector = localizedCliConnectors.find(item => item.id === cliUninstallId)
    if (connector === undefined) return
    if (connector.phase === 'error' && connector.lastError !== undefined) {
      setCliUninstallError(connector.lastError)
    }
    if (connector.phase === 'idle' && !connector.installed) {
      setCliUninstallId(null)
      setCliUninstallError(null)
      notifyConnectionsChanged()
    }
  }, [localizedCliConnectors, cliUninstallId])

  const cliDetail = localizedCliConnectors.find(connector => connector.id === cliDetailId) ?? null
  const cliInstall = localizedCliConnectors.find(connector => connector.id === cliInstallId) ?? null
  const cliLogin = localizedCliConnectors.find(connector => connector.id === cliLoginId) ?? null
  const cliUninstall = localizedCliConnectors.find(connector => connector.id === cliUninstallId) ?? null
  const cliUpdate = localizedCliConnectors.find(connector => connector.id === cliUpdateId) ?? null
  const cliErrorConnector = localizedCliConnectors.find(connector => connector.id === cliErrorId) ?? null

  const localizedCards = useMemo(() => cards.map(localizedCard), [cards, localeRevision])

  const categoryLabels = useMemo(() => {
    const labels = new Map<string, string>()
    for (const card of localizedCards) {
      if (!labels.has(card.category)) labels.set(card.category, card.categoryLabel ?? tr(card.category))
    }
    for (const connector of localizedCliConnectors) {
      if (!labels.has(connector.category)) labels.set(connector.category, tr(connector.category))
    }
    return labels
  }, [localizedCards, localizedCliConnectors])

  const categories = useMemo(() => {
    const present = new Set([
      ...localizedCards.map(card => card.category),
      ...cliConnectors.map(connector => connector.category),
    ])
    const builtinSet = new Set<string>(BUILTIN_CATEGORIES)
    const builtin = BUILTIN_CATEGORIES.filter(category => present.has(category))
    const custom = [...present]
      .filter(category => !builtinSet.has(category))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    return ['全部', ...builtin, ...custom]
  }, [localizedCards, cliConnectors])

  const categoryOptions = useMemo(() => {
    const builtinSet = new Set<string>(BUILTIN_CATEGORIES)
    const custom = [...new Set(
      localizedCards.map(card => card.category).filter(category => !builtinSet.has(category)),
    )].sort((left, right) => left.localeCompare(right, 'zh-CN'))
    return [...BUILTIN_CATEGORIES, ...custom]
  }, [localizedCards])

  useEffect(() => {
    if (!categories.includes(category)) setCategory('全部')
  }, [categories, category])

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return localizedCards.filter(card => {
      if (category !== '全部' && card.category !== category) return false
      if (keyword.length === 0) return true
      return `${card.name} ${card.vendor ?? ''} ${card.summary} ${(card.tags ?? []).join(' ')}`.toLowerCase().includes(keyword)
    })
  }, [localizedCards, category, query])

  const visibleCli = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return localizedCliConnectors.filter(connector => {
      if (category !== '全部' && connector.category !== category) return false
      if (keyword.length === 0) return true
      return `${connector.name} ${connector.vendor} ${connector.description} ${connector.examples.join(' ')}`.toLowerCase().includes(keyword)
    })
  }, [category, localizedCliConnectors, query])

  const gridEntries = useMemo(() => {
    const rank = new Map<string, number>(BUILTIN_CATEGORIES.map((category, index) => [category, index]))
    const categoryRank = (category: string): number => rank.get(category) ?? BUILTIN_CATEGORIES.length
    const items = [
      ...visible.map((card, index) => ({ kind: 'mcp' as const, category: card.category, index, card })),
      ...visibleCli.map((connector, index) => ({ kind: 'cli' as const, category: connector.category, index, connector })),
    ]
    return items.sort((left, right) => categoryRank(left.category) - categoryRank(right.category)
      || left.category.localeCompare(right.category, 'zh-CN')
      || (left.kind === right.kind ? left.index - right.index : left.kind === 'mcp' ? -1 : 1))
  }, [visible, visibleCli])

  const openDialog = (card: ConnectorCard, install = false): void => {
    setDialogError(null)
    setDialogInstall(install)
    setDialogCard(card)
  }

  const openCredentialDialog = (card: ConnectorCard, mode: 'install' | 'update' = 'update'): void => {
    setCredentialError(null)
    setCredentialMode(mode)
    setCredentialCard(card)
  }

  const saveCredential = (card: ConnectorCard, token: string): void => {
    setCredentialSaving(card.id)
    setCredentialError(null)
    clearCardError(card.id)
    void (async () => {
      try {
        const response = await withInstallFeedback(request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections`, {
          method: 'POST',
          body: JSON.stringify({ connectorId: card.id, token }),
        }))
        const connection = response.value?.connection
        if (connection === undefined) throw new ApiError('invalid_response', tr('保存失败：宿主没有返回连接'))
        applyConnection(connection)
        if (connection.authorized && connection.error === undefined && connection.tools.length === 0) refreshSoon()
        setCredentialCard(current => current !== null && current.id === card.id ? null : current)
        if (dialogCardRef.current?.id === card.id) {
          setDialogError(null)
          setDialogInstall(false)
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setCardError(card.id, message)
        setCredentialError({ cardId: card.id, message })
        if (dialogCardRef.current?.id === card.id) setDialogError(message)
      } finally {
        setCredentialSaving(current => current === card.id ? null : current)
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

  const isUserOAuthCard = (card: ConnectorCard): boolean =>
    card.auth.type === 'oauth2' && card.auth.registration === 'user'

  const startOAuthFlow = (
    card: ConnectorCard,
    installFirst: boolean,
    surface: 'dialog' | 'page' = 'dialog',
    force = false,
  ): void => {
    if (isUserOAuthCard(card) && connections[card.id]?.oauthClientReady !== true) {
      clearCardError(card.id)
      if (surface === 'dialog') setDialogError(null)
      setOauthAppError(null)
      setOauthAppCard(card)
      return
    }
    runOAuth(card, installFirst, surface, force)
  }

  const submitOAuthApp = (clientId: string, clientSecret: string): void => {
    const card = oauthAppCard
    if (card === null || oauthAppSaving) return
    setOauthAppSaving(true)
    setOauthAppError(null)
    void (async () => {
      try {
        if (connections[card.id] === undefined) {
          const installed = await installConnector(card)
          applyConnection(installed)
        }
        const updated = await saveOAuthClient(card, clientId, clientSecret)
        applyConnection(updated)
        setOauthAppCard(null)
        runOAuth(card, false, dialogCard?.id === card.id ? 'dialog' : 'page', false, updated)
      } catch (cause) {
        setOauthAppError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setOauthAppSaving(false)
      }
    })()
  }

  const connect = (card: ConnectorCard, token?: string, surface: 'dialog' | 'page' = 'dialog'): Promise<boolean> => {
    setPending(card.id)
    setConnectingId(card.id)
    clearCardError(card.id)
    if (surface === 'dialog') setDialogError(null)
    return (async () => {
      try {
        const body: Record<string, string> = { connectorId: card.id }
        if (token !== undefined) body.token = token
        const response = await withInstallFeedback(request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections`, {
          method: 'POST',
          body: JSON.stringify(body),
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
        setCardError(card.id, message)
        if (surface === 'dialog') setDialogError(message)
        announceConnectorFlowError(card.id, message)
        refreshConnections()
        notifyConnectionsChanged()
        return false
      } finally {
        setPending(null)
        setConnectingId(current => current === card.id ? null : current)
        announceConnectorFlowFinished(card.id)
      }
    })()
  }

  const installConnector = async (card: ConnectorCard): Promise<ConnectionView> => {
    const response = await withInstallFeedback(request<ConnectResponse>(`${ROUTE_PREFIX}/api/connections`, {
      method: 'POST',
      body: JSON.stringify({ connectorId: card.id }),
    }))
    const connection = response.value?.connection
    if (connection === undefined) throw new ApiError('invalid_response', tr('安装失败：宿主没有返回连接'))
    return connection
  }

  const installRecord = (card: ConnectorCard, surface: 'dialog' | 'page'): void => {
    setPending(card.id)
    clearCardError(card.id)
    if (surface === 'dialog') setDialogError(null)
    void (async () => {
      try {
        const connection = await installConnector(card)
        applyConnection(connection)
        if (card.instance !== undefined) {
          openInstanceDialog(card, 'config', surface === 'dialog')
          setDialogInstall(false)
          if (surface === 'dialog') setDialogError(null)
          return
        }
        if (isTokenCard(card)) {
          openCredentialDialog(card, 'install')
          if (surface === 'page') setDialogCard(null)
          setDialogInstall(false)
          if (surface === 'dialog') setDialogError(null)
          return
        }
        if (surface === 'page') setDialogCard(card)
        setDialogInstall(false)
        if (surface === 'dialog') setDialogError(null)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setCardError(card.id, message)
        if (surface === 'dialog') setDialogError(message)
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
    clearCardError(card.id)
    if (surface === 'dialog') setDialogError(null)
    void (async () => {
      try {
        let connection = presetConnection ?? connections[card.id]
        if (presetConnection === undefined && (installFirst || connection === undefined)) {
          connection = await installConnector(card)
          applyConnection(connection)
          setDialogInstall(false)
        }
        if (connection === undefined) {
          throw new ApiError('not_installed', tr('请先安装连接器，再发起授权'))
        }
        if (force || !connection.authorized) {
          window.dispatchEvent(new CustomEvent('dshc:flow-authorizing', { detail: { cardId: card.id } }))
          const authorized = await authorizeConnector(card, {
            signal: controller.signal,
            onFlow: flow => {
              setOAuthFlow({ ...flow, connectorId: card.id })
              if (!flow.opened) {
                setDialogCard(card)
                announceConnectorFlow(card.id)
              }
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
          setCardError(card.id, message)
          if (surface === 'dialog') setDialogError(message)
          announceConnectorFlowError(card.id, message)
        }
        refreshConnections()
        notifyConnectionsChanged()
      } finally {
        setPending(null)
        setOauthStarting(null)
        setOAuthFlow(null)
        oauthAbortRef.current = null
        announceConnectorFlowFinished(card.id)
      }
    })()
  }

  const openInstanceDialog = (card: ConnectorCard, mode: 'config' | 'replace', fromDetail = false): void => {
    setInstanceError(null)
    setInstanceMode(mode)
    setInstanceReturnToDetail(fromDetail)
    setDialogCard(null)
    setInstanceCard(card)
  }

  const submitInstance = (card: ConnectorCard, instanceUrl: string): void => {
    const mode = instanceMode
    setInstancePending(true)
    setInstanceError(null)
    clearCardError(card.id)
    void (async () => {
      try {
        const response = await withInstallFeedback(request<ConnectResponse>(
          `${ROUTE_PREFIX}/api/connections/${encodeURIComponent(card.id)}/instance`,
          { method: 'POST', body: JSON.stringify({ instanceUrl }) },
        ))
        const connection = response.value?.connection
        if (connection === undefined) throw new ApiError('invalid_response', tr('保存地址失败：宿主没有返回连接'))
        applyConnection(connection)
        setInstanceCard(null)
        setDialogError(null)
        setDialogInstall(false)
        if (isOAuthCard(card)) {
          runOAuth(card, false, 'page', mode === 'replace', connection)
        } else if (isTokenCard(card)) {
          if (mode === 'replace' && connection.authorized === true) {
            setDialogCard(card)
            return
          }
          openCredentialDialog(card, 'install')
        } else {
          setDialogCard(card)
          void connect(card, undefined, 'dialog')
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setCardError(card.id, message)
        setInstanceError(message)
      } finally {
        setInstancePending(false)
      }
    })()
  }

  const installWithRow = (card: ConnectorCard, kind: 'token' | 'instance'): void => {
    const op = { cardId: card.id, kind, canceled: false }
    installOpRef.current = op
    clearCardError(card.id)
    void (async () => {
      try {
        const connection = await withInstallFeedback(installConnector(card))
        if (op.canceled) {
          try {
            await request(`${ROUTE_PREFIX}/api/connections/${encodeURIComponent(card.id)}`, { method: 'DELETE' })
          } catch (cause) {
            setCardError(card.id, cause instanceof Error ? cause.message : String(cause))
          }
          notifyConnectionsChanged()
          refreshConnections()
          return
        }
        applyConnection(connection)
        if (kind === 'token') openCredentialDialog(card, 'install')
        else openInstanceDialog(card, 'config')
        announceConnectorFlow(card.id)
      } catch (cause) {
        if (op.canceled) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setCardError(card.id, message)
        announceConnectorFlowError(card.id, message)
      } finally {
        if (installOpRef.current === op) installOpRef.current = null
        announceConnectorFlowFinished(card.id)
      }
    })()
  }

  const openFlow = (card: ConnectorCard): void => {
    announceConnectorFlowStarted(card.id)
    const connection = connections[card.id]
    if (card.instance !== undefined && connection !== undefined && connection.instanceReady !== true) {
      openInstanceDialog(card, 'config')
      announceConnectorFlow(card.id)
      return
    }
    if (connection === undefined) {
      if (card.instance !== undefined) {
        installWithRow(card, 'instance')
        return
      }
      if (isOAuthCard(card)) {
        startOAuthFlow(card, true, 'page')
        return
      }
      if (isTokenCard(card)) {
        installWithRow(card, 'token')
        return
      }
      void connect(card, undefined, 'page')
      return
    }
    if (!connection.authorized) {
      if (isTokenCard(card)) {
        openCredentialDialog(card, 'install')
        announceConnectorFlow(card.id)
        return
      }
      if (isOAuthCard(card)) {
        startOAuthFlow(card, false, 'page')
        return
      }
      void connect(card, undefined, 'page')
      return
    }
    if (connection.error !== undefined) {
      if (isTokenCard(card)) {
        openCredentialDialog(card, 'update')
        announceConnectorFlow(card.id)
        return
      }
      if (isOAuthCard(card)) {
        startOAuthFlow(card, false, 'page', true)
        return
      }
      if (card.instance !== undefined) {
        openInstanceDialog(card, 'replace')
        announceConnectorFlow(card.id)
        return
      }
      void connect(card, undefined, 'page')
      return
    }
    openDialog(card, false)
    announceConnectorFlow(card.id)
  }

  useEffect(() => {
    if (variant !== 'overlay') return
    const onRequest = (): void => setFlowTick(current => current + 1)
    window.addEventListener('dshc:flow-request', onRequest)
    if (flowRequest !== null) onRequest()
    return () => window.removeEventListener('dshc:flow-request', onRequest)
  }, [variant])

  useEffect(() => {
    if (variant !== 'overlay' || flowRequest === null || loading) return
    const cardId = flowRequest
    const card = localizedCards.find(item => item.id === cardId)
    flowRequest = null
    if (card !== undefined) openFlow(card)
  }, [variant, flowTick, loading, localizedCards, connections])

  useEffect(() => {
    if (variant !== 'overlay') return
    const onCancel = (event: Event): void => {
      const cardId = (event as CustomEvent<{ cardId?: string }>).detail?.cardId
      if (cardId === undefined) return
      if (oauthStarting === cardId || oauthFlow?.connectorId === cardId) {
        cancelAuthorize()
        return
      }
      const op = installOpRef.current
      if (op !== null && op.cardId === cardId) op.canceled = true
    }
    window.addEventListener('dshc:flow-cancel', onCancel)
    return () => window.removeEventListener('dshc:flow-cancel', onCancel)
  }, [variant, oauthStarting, oauthFlow])

  useEffect(() => {
    if (variant !== 'panel') return
    const onRequest = (): void => {
      setDialogCard(null)
      setCredentialCard(null)
      setInstanceCard(null)
      setDeleteCard(null)
      setCustomOpen(false)
      setEditCard(null)
    }
    window.addEventListener('dshc:flow-request', onRequest)
    return () => window.removeEventListener('dshc:flow-request', onRequest)
  }, [variant])

  const openCustomEdit = (card: ConnectorCard, fromDetail = false): void => {
    clearCardError(card.id)
    setDialogCard(null)
    setEditReturnToDetail(fromDetail)
    setEditCard(null)
    setEditConfig(null)
    void (async () => {
      try {
        const response = await request<CustomConfigPayload>(
          `${ROUTE_PREFIX}/api/custom-connectors/${encodeURIComponent(card.id)}/config`,
        )
        setEditConfig(response.value.config)
        setEditCard(card)
      } catch (cause) {
        setCardError(card.id, cause instanceof Error ? cause.message : String(cause))
        if (fromDetail) setDialogCard(card)
      }
    })()
  }

  const closeCustomEdit = (): void => {
    setEditCard(null)
    setEditConfig(null)
    if (editReturnToDetail) setDialogCard(editCard)
  }

  const applyCustomEdit = (result: CustomUpdatePayload['value']): void => {
    const updated = canonicalizeCardCategories([result.card])[0] ?? result.card
    setCards(previous => canonicalizeCardCategories(
      previous.map(card => (card.id === updated.id ? updated : card)),
    ))
    if (result.disconnected) {
      setConnections(previous => {
        const next = { ...previous }
        delete next[updated.id]
        return next
      })
    }
    setEditCard(null)
    setEditConfig(null)
    if (editReturnToDetail) setDialogCard(updated)
    notifyConnectionsChanged()
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
    clearCardError(card.id)
    if (surface === 'dialog') setDialogError(null)
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
        setCardError(card.id, message)
        if (surface === 'dialog') setDialogError(message)
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

  const renderCard = (card: ConnectorCard): JSX.Element => (
    <ConnectorCardView
    key={card.id}
    card={card}
    connection={connections[card.id]}
    errorMessage={cardErrors[card.id]}
    togglePending={togglePending === card.id}
    authorizing={isAuthorizing(card)}
    installing={pending === card.id}
    connecting={credentialSaving === card.id || connectingId === card.id}
    onOpen={() => openDialog(card, false)}
    onInstall={() => {
      if (card.instance !== undefined) {
        installRecord(card, 'page')
        return
      }
      if (isOAuthCard(card)) {
        startOAuthFlow(card, true, 'page')
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
      if (card.instance !== undefined && connections[card.id]?.instanceReady !== true) {
        openInstanceDialog(card, 'config')
        return
      }
      if (isOAuthCard(card)) {
        startOAuthFlow(card, false, 'page')
        return
      }
      if (isTokenCard(card)) {
        openCredentialDialog(card, connections[card.id]?.authorized === true ? 'update' : 'install')
        return
      }
      openDialog(card, false)
    }}
    onCancelAuthorize={cancelAuthorize}
    onUpdateCredential={isTokenCard(card) && connections[card.id]?.authorized === true
      ? () => openCredentialDialog(card)
      : undefined}
    onReauthorize={isOAuthCard(card) && connections[card.id]?.authorized === true
      ? () => startOAuthFlow(card, false, 'page', true)
      : undefined}
    onReconfigureInstance={card.instance !== undefined && connections[card.id]?.instanceReady === true
      ? () => openInstanceDialog(card, 'replace')
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
    onEditCustom={card.source === 'custom' ? () => openCustomEdit(card) : undefined}
  />
  )

  const renderCli = (connector: CliConnectorView): JSX.Element => (
    <CliCardView
    key={connector.id}
    connector={connector}
    togglePending={cliTogglePending === connector.id}
    pending={cliBusyId === connector.id}
    onOpen={() => setCliDetailId(connector.id)}
    onInstall={() => setCliInstallId(connector.id)}
    onLogin={() => runCliAction(connector.id, 'login')}
    onLogout={() => runCliAction(connector.id, 'logout')}
    onOpenInstall={() => setCliInstallId(connector.id)}
    onOpenLogin={() => setCliLoginId(connector.id)}
    onToggle={enabled => toggleCli(connector, enabled)}
    onTrial={() => trialCli(connector)}
    onOpenError={() => setCliErrorId(connector.id)}
    onCancel={() => runCliAction(connector.id, 'cancel')}
    onUninstall={() => {
      setCliUninstallError(null)
      setCliUninstallId(connector.id)
    }}
    onOpenUninstall={() => {
      setCliUninstallError(null)
      setCliUninstallId(connector.id)
    }}
    onUpdate={() => {
      setCliUpdateError(null)
      setCliUpdateId(connector.id)
      startCliUpdate(connector)
    }}
    onOpenUpdate={() => {
      setCliUpdateError(null)
      setCliUpdateStarted(true)
      setCliUpdateId(connector.id)
    }}
  />
  )

  return (
    <div className={variant === 'overlay' ? 'dshc-root dshc-flow-root' : 'dshc-root'}>
      <div className="dshc-inner">
        <header className="dshc-header">
          <h1>{tr('连接器')}</h1>
          <button type="button" className="dshc-btn dshc-btn-primary dshc-create" onClick={() => setCustomOpen(true)}>
            <IconPlus size={13} />
            {tr('自定义连接器')}
          </button>
        </header>

        <nav
          className="dshc-tabs"
          onWheel={event => {
            const element = event.currentTarget
            if (element.scrollWidth <= element.clientWidth) return
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
            element.scrollLeft += event.deltaY
            event.preventDefault()
          }}
        >
          {categories.map(item => (
            <button
              key={item}
              type="button"
              className={item === category ? 'dshc-tab dshc-tab-active' : 'dshc-tab'}
              onClick={() => setCategory(item)}
            >
              {categoryLabels.get(item) ?? tr(item)}
            </button>
          ))}
        </nav>

        <label className="dshc-search">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            name="dsh-connector-search"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            placeholder={tr('搜索连接器')}
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          {query !== '' && (
            <button
              type="button"
              className="dshc-search-clear"
              aria-label={tr('清空搜索')}
              title={tr('清空搜索')}
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
            >
              <IconClose size={12} />
            </button>
          )}
        </label>

        {error !== null && <div className="dshc-error">{error}</div>}

        {visible.length === 0 && visibleCli.length === 0
          ? <div className="dshc-empty">{loading ? tr('正在加载连接器…') : tr('没有匹配的连接器')}</div>
          : (
            <div className="dshc-grid">
              {gridEntries.map(entry => entry.kind === 'mcp' ? renderCard(entry.card) : renderCli(entry.connector))}
            </div>
          )}
      </div>

      {dialogCard !== null && (
        <ConnectorDialog
          card={dialogCard}
          connection={connections[dialogCard.id]}
          pending={pending === dialogCard.id || credentialSaving === dialogCard.id}
          toggling={togglePending === dialogCard.id}
          authorizing={isAuthorizing(dialogCard)}
          connecting={connectingId === dialogCard.id || credentialSaving === dialogCard.id}
          authorizeLink={oauthFlow?.connectorId === dialogCard.id ? oauthFlow.authorizeUrl : null}
          installOpen={dialogInstall}
          error={dialogError}
          behind={credentialCard !== null || deleteCard !== null}
          escLocked={credentialCard !== null || deleteCard !== null}
          onClose={() => {
            setDialogCard(null)
            setDialogInstall(false)
            setDialogError(null)
          }}
          onBeginInstall={() => {
            if (dialogCard.instance !== undefined || isTokenCard(dialogCard)) {
              installRecord(dialogCard, 'dialog')
              return
            }
            if (dialogCard.auth.type === 'none') {
              void connect(dialogCard, undefined, 'dialog')
              return
            }
            startOAuthFlow(dialogCard, true, 'dialog')
          }}
          onCancelInstall={() => {
            setDialogInstall(false)
            setDialogError(null)
          }}
          onConnect={token => connect(dialogCard, token, 'dialog')}
          onInstallOAuth={() => runOAuth(dialogCard, true)}
          onConfigureInstance={() => openInstanceDialog(dialogCard, 'config', true)}
          onAuthorize={() => startOAuthFlow(dialogCard, false)}
          onReauthorize={() => startOAuthFlow(dialogCard, false, 'dialog', true)}
          onReconfigureInstance={dialogCard.instance !== undefined && connections[dialogCard.id]?.instanceReady === true
            ? () => openInstanceDialog(dialogCard, 'replace', true)
            : undefined}
          onUpdateCredential={() => openCredentialDialog(
            dialogCard,
            connections[dialogCard.id]?.authorized === true ? 'update' : 'install',
          )}
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
          onEditCustom={dialogCard.source === 'custom'
            ? () => openCustomEdit(dialogCard, true)
            : undefined}
        />
      )}

      {credentialCard !== null && (
        <CredentialDialog
          card={credentialCard}
          mode={credentialMode}
          saving={credentialSaving === credentialCard.id}
          error={credentialError !== null && credentialError.cardId === credentialCard.id ? credentialError.message : null}
          onClose={() => {
            setCredentialCard(null)
            setCredentialError(null)
          }}
          onSubmit={token => saveCredential(credentialCard, token)}
        />
      )}

      {oauthAppCard !== null && (
        <OAuthAppDialog
          card={oauthAppCard}
          saving={oauthAppSaving}
          error={oauthAppError}
          onClose={() => {
            setOauthAppCard(null)
            setOauthAppError(null)
          }}
          onSubmit={submitOAuthApp}
        />
      )}

      {instanceCard !== null && (
        <InstanceDialog
          card={instanceCard}
          mode={instanceMode}
          pending={instancePending}
          error={instanceError}
          onClose={() => {
            if (!instancePending) {
              setInstanceCard(null)
              setInstanceError(null)
              if (instanceReturnToDetail) setDialogCard(instanceCard)
            }
          }}
          onSubmit={instanceUrl => submitInstance(instanceCard, instanceUrl)}
        />
      )}

      {editCard !== null && editConfig !== null && (
        <CustomConnectorDialog
          categoryOptions={categoryOptions}
          onClose={closeCustomEdit}
          onImported={onImported}
          editing={{ connectorId: editCard.id, initial: editConfig }}
          onEdited={applyCustomEdit}
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

      {cliInstall !== null && (
        <CliInstallDialog
          connector={cliInstall}
          pending={cliBusyId === cliInstall.id}
          onClose={() => setCliInstallId(null)}
          onConfirm={() => runCliAction(cliInstall.id, 'install')}
          onCancel={() => runCliAction(cliInstall.id, 'cancel')}
        />
      )}

      {cliLogin !== null && (
        <CliLoginDialog
          connector={cliLogin}
          onCancel={() => runCliAction(cliLogin.id, 'cancel')}
          onClose={() => setCliLoginId(null)}
        />
      )}

      {cliUninstall !== null && (
        <CliUninstallDialog
          connector={cliUninstall}
          running={cliUninstall.phase === 'uninstalling'}
          pending={cliUninstallPending}
          error={cliUninstallError}
          onClose={closeCliUninstall}
          onConfirm={() => uninstallCli(cliUninstall)}
          onCancel={() => cancelUninstall(cliUninstall)}
        />
      )}

      {cliUpdate !== null && (
        <CliUpdateDialog
          connector={cliUpdate}
          running={cliUpdate.phase === 'updating'}
          started={cliUpdateStarted}
          error={cliUpdateError}
          onClose={closeCliUpdate}
        />
      )}

      {cliDetail !== null && (
        <CliDetailDialog
          connector={cliDetail}
          onClose={() => setCliDetailId(null)}
          onTrial={example => {
            setCliDetailId(null)
            trialCli(cliDetail, example)
          }}
          onInstall={() => {
            const id = cliDetail.id
            setCliDetailId(null)
            setCliInstallId(id)
          }}
          onLogin={() => {
            const id = cliDetail.id
            setCliDetailId(null)
            runCliAction(id, 'login')
          }}
          onUninstall={() => {
            const id = cliDetail.id
            setCliDetailId(null)
            setCliUninstallError(null)
            setCliUninstallId(id)
          }}
        />
      )}

      {cliErrorConnector !== null && (
        <CliErrorDialog
          connector={cliErrorConnector}
          onClose={() => setCliErrorId(null)}
        />
      )}
    </div>
  )
}

interface CliCardViewProps {
  connector: CliConnectorView
  togglePending: boolean
  pending: boolean
  onOpen: () => void
  onInstall: () => void
  onLogin: () => void
  onLogout: () => void
  onOpenInstall: () => void
  onOpenLogin: () => void
  onToggle: (enabled: boolean) => void
  onTrial: () => void
  onOpenError: () => void
  onCancel: () => void
  onUninstall: () => void
  onOpenUninstall: () => void
  onUpdate: () => void
  onOpenUpdate: () => void
}

function CliCardView({ connector, togglePending, pending, onOpen, onInstall, onLogin, onLogout, onOpenInstall, onOpenLogin, onToggle, onTrial, onOpenError, onCancel, onUninstall, onOpenUninstall, onUpdate, onOpenUpdate }: CliCardViewProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuAbove, setMenuAbove] = useState(false)
  const [tip, setTip] = useState<CardTip | null>(null)
  const menuRef = useRef<HTMLSpanElement>(null)
  const busy = pending
    || connector.phase === 'installing'
    || connector.phase === 'updating'
    || connector.phase === 'configuring'
    || connector.phase === 'logging_in'
    || connector.phase === 'uninstalling'
  const enabled = connector.enabled !== false
  const connected = connector.installed && connector.authenticated
  const canTry = connected && enabled && connector.skills.installed && !busy
  const error = !busy && connector.phase === 'error' && connector.lastError !== undefined ? connector.lastError : undefined
  const busyLabel = connector.phase === 'installing'
    ? tr('安装中…')
    : connector.phase === 'updating'
      ? tr('更新中…')
      : connector.phase === 'uninstalling'
        ? tr('卸载中…')
        : connector.phase === 'configuring' ? tr('配置中…') : tr('登录中…')
  const busyProgress = connector.phase === 'installing'
    ? tr('安装进度')
    : connector.phase === 'updating'
      ? tr('更新进度')
      : connector.phase === 'uninstalling' ? tr('卸载进度') : tr('登录进度')
  const stateLabel = busy
    ? tr('，处理中')
    : !connector.installed
      ? tr('，未安装')
      : !connector.authenticated
        ? tr('，已安装未登录')
        : enabled ? tr('，已登录') : tr('，已停用')

  const toggleMenu = (button: HTMLElement): void => {
    const rect = button.getBoundingClientRect()
    setMenuAbove(rect.bottom + 170 > window.innerHeight)
    setMenuOpen(current => !current)
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

  useEffect(() => {
    if (tip === null) return
    const close = (): void => setTip(null)
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [tip])

  const showTip = (element: HTMLElement): void => {
    if (element.scrollHeight <= element.clientHeight + 1) return
    const rect = element.getBoundingClientRect()
    const width = Math.min(360, window.innerWidth - 32)
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))
    setTip({ text: connector.description, left, top: rect.bottom + 8 })
  }

  const actionClass = error !== undefined
    ? 'dshc-card-action dshc-card-action-error'
    : enabled ? 'dshc-card-action dshc-card-action-connected' : 'dshc-card-action dshc-card-action-disabled'

  return (
    <>
      <article
        className={menuOpen ? 'dshc-card dshc-card-menu-open' : 'dshc-card'}
        role="button"
        tabIndex={0}
        aria-label={tr("查看 {v0}{v1}", { v0: connector.name, v1: stateLabel })}
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
          <span className="dshc-avatar"><CliLogo connector={connector} size={22} /></span>
          <div className="dshc-card-title">
            <strong>{connector.name}</strong>
            <span>{connector.vendor} · CLI</span>
          </div>
        </div>
        <p
          className="dshc-summary"
          onMouseEnter={event => showTip(event.currentTarget)}
          onMouseLeave={() => setTip(null)}
          onPointerLeave={() => setTip(null)}
        >
          {connector.description}
        </p>
        <div className="dshc-card-foot">
          <span className="dshc-badge">{tr(connector.category)}</span>
          {!connector.installed ? (
            <span className="dshc-card-install-actions">
              {error !== undefined && (
                <button
                  type="button"
                  className="dshc-card-action dshc-card-action-error dshc-card-status"
                  title={tr("查看错误日志")}
                  aria-label={tr("查看 {v0} 错误日志", { v0: connector.name })}
                  onClick={event => {
                    event.stopPropagation()
                    onOpenError()
                  }}
                >
                  <IconAlert size={16} />
                </button>
              )}
              <button
                type="button"
                className={busy
                  ? 'dshc-card-action dshc-card-action-connect dshc-card-action-loading'
                  : 'dshc-card-action dshc-card-action-connect'}
                title={tr("安装")}
                aria-label={tr("安装 {v0} CLI", { v0: connector.name })}
                onClick={event => {
                  event.stopPropagation()
                  if (busy) onOpenInstall()
                  else onInstall()
                }}
              >
                {busy ? <Spinner /> : <IconPlus size={16} />}
              </button>
            </span>
          ) : !connector.authenticated ? (
            <span className="dshc-card-auth-actions">
              <button
                type="button"
                className="dshc-card-auth"
                aria-label={busy ? tr("查看 {v0} {v1}", { v0: connector.name, v1: busyProgress }) : tr("登录 {v0}", { v0: connector.name })}
                title={busy ? (connector.stage ?? busyLabel) : undefined}
                onClick={event => {
                  event.stopPropagation()
                  if (connector.phase === 'uninstalling') onOpenUninstall()
                  else if (connector.phase === 'updating') onOpenUpdate()
                  else if (busy) onOpenLogin()
                  else onLogin()
                }}
              >
                {busy && <Spinner inline />}
                {busy ? busyLabel : tr('登录')}
              </button>
              {!busy && (error !== undefined
                ? <button
                    type="button"
                    className="dshc-card-action dshc-card-action-error dshc-card-status"
                    title={tr("查看错误日志")}
                    aria-label={tr("查看 {v0} 错误日志", { v0: connector.name })}
                    onClick={event => {
                      event.stopPropagation()
                      onOpenError()
                    }}
                  >
                    <IconAlert size={16} />
                  </button>
                : <span className="dshc-card-installed" title={tr("CLI 已安装")} aria-label={tr("CLI 已安装")}>
                    <IconCheck size={14} />
                  </span>)}
              <span className="dshc-card-more-wrap" ref={menuRef}>
                <button
                  type="button"
                  className="dshc-card-more"
                  aria-label={tr("{v0} 更多操作", { v0: connector.name })}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={event => {
                    event.stopPropagation()
                    toggleMenu(event.currentTarget)
                  }}
                >
                  <IconMore size={16} />
                </button>
                {menuOpen && (
                  <span className={menuAbove ? 'dshc-menu dshc-menu-above' : 'dshc-menu'} role="menu" onClick={event => event.stopPropagation()}>
                    {busy ? (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className="dshc-menu-item dshc-menu-item-danger"
                          onClick={() => {
                            setMenuOpen(false)
                            onCancel()
                          }}
                        >
                          <IconClose size={14} />
                          {connector.phase === 'uninstalling'
                            ? tr('取消卸载')
                            : connector.phase === 'updating' ? tr('取消更新') : tr('取消登录')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className="dshc-menu-item"
                          onClick={() => {
                            setMenuOpen(false)
                            onUpdate()
                          }}
                        >
                          <IconRefresh size={14} />
                          
                          {tr("更新 CLI")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="dshc-menu-item dshc-menu-item-danger"
                          onClick={() => {
                            setMenuOpen(false)
                            onUninstall()
                          }}
                        >
                          <IconTrash size={14} />
                          
                          {tr("卸载 CLI")}
                        </button>
                      </>
                    )}
                  </span>
                )}
              </span>
            </span>
          ) : (
            <span className={busy ? 'dshc-card-actions dshc-card-actions-busy' : 'dshc-card-actions'}>
              {busy
                ? <button
                    type="button"
                    className="dshc-card-auth"
                    title={connector.stage ?? busyLabel}
                    aria-label={tr("查看 {v0} {v1}", { v0: connector.name, v1: busyProgress })}
                    onClick={event => {
                      event.stopPropagation()
                      if (connector.phase === 'installing') onOpenInstall()
                      else if (connector.phase === 'updating') onOpenUpdate()
                      else if (connector.phase === 'uninstalling') onOpenUninstall()
                      else onOpenLogin()
                    }}
                  >
                    <Spinner inline />
                    {busyLabel}
                  </button>
                : error !== undefined
                  ? <button
                      type="button"
                      className={`${actionClass} dshc-card-status`}
                      title={tr("查看错误日志")}
                      aria-label={tr("查看 {v0} 错误日志", { v0: connector.name })}
                      onClick={event => {
                        event.stopPropagation()
                        onOpenError()
                      }}
                    >
                      <IconAlert size={16} />
                    </button>
                  : <span className={`${actionClass} dshc-card-status`} title={enabled ? tr('已启用') : tr('已停用')} aria-hidden>
                      <IconCheck size={16} />
                    </span>}
              <span className="dshc-card-controls">
                <span className="dshc-card-more-wrap" ref={menuRef}>
                  <button
                    type="button"
                    className="dshc-card-more"
                    aria-label={tr("{v0} 更多操作", { v0: connector.name })}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={event => {
                      event.stopPropagation()
                      toggleMenu(event.currentTarget)
                    }}
                  >
                    <IconMore size={16} />
                  </button>
                  {menuOpen && (
                    <span className={menuAbove ? 'dshc-menu dshc-menu-above' : 'dshc-menu'} role="menu" onClick={event => event.stopPropagation()}>
                      {busy ? (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            className="dshc-menu-item dshc-menu-item-danger"
                            onClick={() => {
                              setMenuOpen(false)
                              onCancel()
                            }}
                          >
                            <IconClose size={14} />
                            {connector.phase === 'installing'
                              ? tr('取消安装')
                              : connector.phase === 'updating'
                                ? tr('取消更新')
                                : connector.phase === 'uninstalling' ? tr('取消卸载') : tr('取消登录')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            className="dshc-menu-item"
                            disabled={!canTry}
                            onClick={() => {
                              setMenuOpen(false)
                              onTrial()
                            }}
                          >
                            <IconPlay size={14} />
                            
                            {tr("去试试")}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="dshc-menu-item"
                            onClick={() => {
                              setMenuOpen(false)
                              onLogin()
                            }}
                          >
                            <IconRefresh size={14} />
                            
                            {tr("重新登录")}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="dshc-menu-item"
                            onClick={() => {
                              setMenuOpen(false)
                              onLogout()
                            }}
                          >
                            <IconPlug size={14} />
                            
                            {tr("解绑")}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="dshc-menu-item"
                            onClick={() => {
                              setMenuOpen(false)
                              onUpdate()
                            }}
                          >
                            <IconRefresh size={14} />
                            
                            {tr("更新 CLI")}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="dshc-menu-item dshc-menu-item-danger"
                            onClick={() => {
                              setMenuOpen(false)
                              onUninstall()
                            }}
                          >
                            <IconTrash size={14} />
                            
                            {tr("卸载 CLI")}
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </span>
                {togglePending
                  ? <span className="dshc-card-toggle" role="status" aria-label={tr("处理中")}>
                      <Spinner />
                    </span>
                  : busy
                    ? null
                    : <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label={enabled ? tr("停用 {v0}", { v0: connector.name }) : tr("启用 {v0}", { v0: connector.name })}
                        title={enabled ? tr('停用') : tr('启用')}
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

interface CliInstallDialogProps {
  connector: CliConnectorView
  pending: boolean
  onClose: () => void
  onConfirm: () => void
  onCancel: () => void
}

function CliInstallDialog({ connector, pending, onClose, onConfirm, onCancel }: CliInstallDialogProps): JSX.Element {
  const busy = pending || connector.phase === 'installing'
  const failed = !busy && connector.phase === 'error' && connector.lastError !== undefined
  const done = !busy && connector.installed
  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dshc-dialog dshc-dialog-detail" role="dialog" aria-modal="true" aria-label={tr("安装 {v0} CLI", { v0: connector.name })}>
        <div className="dshc-dialog-head">
          <span className="dshc-dialog-avatar"><CliLogo connector={connector} size={28} /></span>
          <div className="dshc-dialog-title">
            <h2>{done ? tr('安装完成') : tr("安装 {v0} CLI", { v0: connector.name })}</h2>
            <span>{connector.vendor}</span>
          </div>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          {busy ? (
            <>
              <div className="dshc-cli-wait">
                <Spinner />
                <span>{connector.stage ?? tr('安装中…')}</span>
              </div>
              {connector.output !== undefined && connector.output.trim() !== '' && (
                <details className="dshc-cli-output" open>
                  <summary>{tr("安装输出")}</summary>
                  <pre>{connector.output.slice(-4000)}</pre>
                </details>
              )}
            </>
          ) : done ? (
            <>
              <p className="dshc-dialog-hint">{tr("CLI 已安装")}{connector.version === undefined ? '' : ` · v${connector.version}`}{tr("。登录请回到卡片点击「登录」。")}</p>
              {connector.skills.installed && (
                <p className="dshc-dialog-hint">{tr("已发现")} {connector.skills.count}  {tr("个 Skills。")}</p>
              )}
            </>
          ) : (
            <>
              <p className="dshc-dialog-hint">
                
                {tr("将执行以下命令安装官方 CLI 与 Skills。会写入本机 npm 全局目录和")} <code>~/.agents/skills</code>{tr("，影响本机其他 Agent。")}
              </p>
              <pre className="dshc-cli-commands">{connector.installHint.join('\n')}</pre>
              <p className="dshc-dialog-hint">
                <a className="dshc-link" href={connector.docsUrl} target="_blank" rel="noreferrer">{tr("查看官方安装文档")}</a>
              </p>
              {failed && <p className="dshc-dialog-error">{connector.lastError}</p>}
            </>
          )}
        </div>
        <div className="dshc-dialog-actions">
          <span className="dshc-dialog-actions-right">
            {busy ? (
              <>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onCancel}>{tr("取消安装")}</button>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>{tr("关闭")}</button>
              </>
            ) : done ? (
              <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" onClick={onClose}>{tr("关闭")}</button>
            ) : (
              <>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>{tr("取消")}</button>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" onClick={onConfirm}>
                  {failed ? tr('重试') : tr('安装')}
                </button>
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

interface CliLoginDialogProps {
  connector: CliConnectorView
  onCancel: () => void
  onClose: () => void
}

function CliLoginDialog({ connector, onCancel, onClose }: CliLoginDialogProps): JSX.Element {
  const [copied, setCopied] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState<string | null>(null)
  const busy = connector.phase === 'configuring' || connector.phase === 'logging_in'
  const failed = connector.phase === 'error'
  const success = connector.authenticated && !busy
  const link = connector.link
  const statusText = busy
    ? (connector.stage === '配置应用' ? tr('配置应用中') : tr('等待授权'))
    : success ? tr('已登录') : failed ? tr('登录失败') : tr('未登录')
  const statusClass = success
    ? 'dshc-status-pill dshc-status-pill-connected'
    : failed ? 'dshc-status-pill dshc-status-pill-error' : 'dshc-status-pill'
  const accountLabel = connector.account?.name ?? connector.account?.email
  const statusLabel = success && accountLabel !== undefined ? tr("已登录 · {v0}", { v0: accountLabel }) : statusText
  const copy = (value: string, key: string): void => {
    void (async () => {
      try {
        await writeClipboard(value)
        setCopied(key)
        setCopyFailed(null)
        window.setTimeout(() => setCopied(current => (current === key ? null : current)), 1500)
      } catch {
        setCopied(null)
        setCopyFailed(key)
        window.setTimeout(() => setCopyFailed(current => (current === key ? null : current)), 2000)
      }
    })()
  }

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dshc-dialog dshc-dialog-detail" role="dialog" aria-modal="true" aria-label={tr("登录 {v0}", { v0: connector.name })}>
        <div className="dshc-dialog-head">
          <span className="dshc-dialog-avatar"><CliLogo connector={connector} size={28} /></span>
          <div className="dshc-dialog-title">
            <h2>{success ? tr('已登录') : connector.authenticated ? tr('重新登录') : tr("登录 {v0}", { v0: connector.name })}</h2>
            <span>{connector.vendor}</span>
          </div>
          <span className={`${statusClass} dshc-dialog-status-pill`} title={accountLabel}>
            {busy && <Spinner inline />}
            {statusLabel}
          </span>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          {success ? (
            <p className="dshc-dialog-hint">{tr("账号已连接，可以关闭此窗口并让 Agent 使用官方 Skills。")}</p>
          ) : (
            <>
              <p className="dshc-dialog-hint">
                {busy
                  ? connector.stage === '配置应用'
                    ? tr('正在准备应用配置，授权页面会自动打开；若未打开，请点击「打开授权页面」。')
                    : tr('请在浏览器完成登录授权，完成后会自动同步。')
                  : failed
                    ? tr('登录未完成，请关闭后重新点击「登录」；完整错误可从卡片感叹号查看。')
                    : tr('登录流程已结束或尚未开始。')}
              </p>
              {connector.code !== undefined && (
                <div className="dshc-cli-code">
                  <code>{connector.code}</code>
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={() => copy(connector.code ?? '', 'code')}>
                    {copied === 'code' ? tr('已复制') : copyFailed === 'code' ? tr('复制失败') : tr('复制设备码')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <div className="dshc-dialog-actions">
          {!success && (
            <button
              type="button"
              className="dshc-btn dshc-btn-md dshc-btn-ghost"
              onClick={() => {
                onCancel()
                onClose()
              }}
            >
              
              {tr("取消登录")}
            </button>
          )}
          <span className="dshc-dialog-actions-right">
            {success ? (
              <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" onClick={onClose}>{tr("完成")}</button>
            ) : (
              <>
                {link !== undefined && (
                  <button
                    type="button"
                    className="dshc-btn dshc-btn-md dshc-btn-outline"
                    onClick={() => copy(link, 'link')}
                  >
                    {copied === 'link' ? tr('已复制') : copyFailed === 'link' ? tr('复制失败') : tr('复制链接')}
                  </button>
                )}
                {link !== undefined
                  ? (
                      <a className="dshc-btn dshc-btn-md dshc-btn-primary" href={link} target="_blank" rel="noreferrer">
                        
                        {tr("打开授权页面")}
                      </a>
                    )
                  : (
                      <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>
                        
                        {tr("关闭")}
                      </button>
                    )}
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

interface CliUninstallDialogProps {
  connector: CliConnectorView
  running: boolean
  pending: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
  onCancel: () => void
}

function CliUninstallDialog({ connector, running, pending, error, onClose, onConfirm, onCancel }: CliUninstallDialogProps): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dshc-dialog" role="dialog" aria-modal="true" aria-busy={running} aria-label={tr("卸载 {v0} CLI", { v0: connector.name })}>
        <div className="dshc-dialog-head">
          <span className="dshc-dialog-avatar"><CliLogo connector={connector} size={28} /></span>
          <div className="dshc-dialog-title">
            <h2>{tr("卸载")} {connector.name} CLI</h2>
            <span>{connector.vendor}</span>
          </div>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          {running ? (
            <>
              <div className="dshc-cli-wait">
                <Spinner />
                <span>{connector.stage ?? tr('正在卸载 CLI 与官方 Skills…')}</span>
              </div>
              <p className="dshc-dialog-hint">
                
                {tr("卸载在宿主侧继续执行；关闭弹窗不会中止，可以从卡片重新打开进度。")}
              </p>
            </>
          ) : (
            <>
              <p className="dshc-dialog-body">
                
                {tr("将卸载本机 npm 全局 CLI")}{connector.skills.count > 0 ? tr("，并删除 ~/.agents/skills 下 {v0} 个官方 Skills", { v0: connector.skills.count }) : ''}。
              </p>
              <p className="dshc-dialog-hint">
                {connector.skills.count > 0
                  ? tr('其他 Agent 将无法继续使用这些 Skills，当前登录态也会清除；需要重新安装才能恢复。')
                  : tr('其他 Agent 将无法继续使用该 CLI，当前登录态也会清除；需要重新安装才能恢复。')}
              </p>
            </>
          )}
          {error !== null && <p className="dshc-dialog-error">{error}</p>}
        </div>
        <div className="dshc-dialog-actions">
          {running ? (
            <>
              <button
                type="button"
                className="dshc-btn dshc-btn-md dshc-btn-outline dshc-btn-danger"
                disabled={pending}
                onClick={onCancel}
              >
                {pending && <Spinner inline />}
                
                {tr("取消卸载")}
              </button>
              <span className="dshc-dialog-actions-right">
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>
                  
                  {tr("关闭")}
                </button>
              </span>
            </>
          ) : (
            <>
              <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>
                
                {tr("取消")}
              </button>
              <button
                type="button"
                className="dshc-btn dshc-btn-md dshc-btn-outline dshc-btn-danger"
                disabled={pending}
                onClick={onConfirm}
              >
                {pending && <Spinner inline />}
                {pending ? tr('启动中…') : tr('卸载 CLI')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface CliUpdateDialogProps {
  connector: CliConnectorView
  running: boolean
  started: boolean
  error: string | null
  onClose: () => void
}

function CliUpdateDialog({ connector, running, started, error, onClose }: CliUpdateDialogProps): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dshc-dialog" role="dialog" aria-modal="true" aria-busy={running} aria-label={tr("更新 {v0} CLI", { v0: connector.name })}>
        <div className="dshc-dialog-head">
          <span className="dshc-dialog-avatar"><CliLogo connector={connector} size={28} /></span>
          <div className="dshc-dialog-title">
            <h2>{tr("更新")} {connector.name} CLI</h2>
            <span>{connector.vendor}</span>
          </div>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          {running ? (
            <>
              <div className="dshc-cli-wait">
                <Spinner />
                <span>{connector.stage ?? tr('正在更新 CLI…')}</span>
              </div>
              <p className="dshc-dialog-hint">
                
                {tr("更新会原地升级 npm 全局 CLI 并重新拉取 Skills，不会清除登录态；关闭弹窗不会中止，可再次打开查看进度。")}
              </p>
            </>
          ) : (
            <p className="dshc-dialog-body">
              {started ? tr("已更新到 v{v0}。", { v0: connector.version ?? tr('最新版本') }) : tr('准备更新…')}
            </p>
          )}
          {error !== null && <p className="dshc-dialog-error">{error}</p>}
        </div>
        <div className="dshc-dialog-actions">
          <span className="dshc-dialog-actions-right">
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>
              {running ? tr('后台继续') : tr('完成')}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

interface CliDetailDialogProps {
  connector: CliConnectorView
  onClose: () => void
  onTrial: (example: string) => void
  onInstall: () => void
  onLogin: () => void
  onUninstall: () => void
}

function CliDetailDialog({ connector, onClose, onTrial, onInstall, onLogin, onUninstall }: CliDetailDialogProps): JSX.Element {
  const [copied, setCopied] = useState<number | null>(null)
  const [copyFailed, setCopyFailed] = useState<number | null>(null)
  const [showAllCapabilities, setShowAllCapabilities] = useState(false)
  const [exampleTip, setExampleTip] = useState<{
    index: number
    action: 'copy' | 'try'
    left: number
    top: number
    above: boolean
  } | null>(null)
  const busy = connector.phase === 'installing' || connector.phase === 'updating' || connector.phase === 'configuring' || connector.phase === 'logging_in' || connector.phase === 'uninstalling'
  const enabled = connector.enabled !== false
  const canTry = connector.authenticated && connector.installed && enabled && connector.skills.installed && !busy
  const status = busy
    ? (connector.stage ?? tr('处理中'))
    : !connector.installed
      ? tr('未安装')
      : !connector.authenticated
        ? tr('已安装未登录')
        : enabled ? tr('已登录') : tr('已停用')
  const statusClass = connector.authenticated && enabled && !busy
    ? 'dshc-status-pill dshc-status-pill-connected'
    : 'dshc-status-pill'
  const accountLabel = connector.account?.name ?? connector.account?.email
  const statusWithAccount = !busy && accountLabel !== undefined ? `${status} · ${accountLabel}` : status
  const accountTitle = accountLabel === undefined
    ? undefined
    : [accountLabel, connector.account?.org].filter(Boolean).join(' · ')
  const capabilities = connector.capabilities
  const visibleCapabilities = capabilities === undefined
    ? []
    : showAllCapabilities ? capabilities.items : capabilities.items.slice(0, 4)

  useEffect(() => {
    setShowAllCapabilities(false)
  }, [connector.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = (text: string, index: number): void => {
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
      ? (canTry ? tr('去试试') : !connector.authenticated ? tr('登录后可用') : !enabled ? tr('已停用') : tr('Skills 未就绪'))
      : copied === exampleTip.index
        ? tr('已复制')
        : copyFailed === exampleTip.index
          ? tr('复制失败')
          : tr('复制')

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dshc-dialog dshc-dialog-detail" role="dialog" aria-modal="true" aria-label={connector.name}>
        <div className="dshc-dialog-head dshc-dialog-head-detail">
          <span className="dshc-avatar dshc-dialog-avatar dshc-dialog-avatar-lg"><CliLogo connector={connector} size={32} /></span>
          <div className="dshc-dialog-title">
            <h2>{connector.name}</h2>
            <span>{[connector.vendor, tr(connector.category)].join(' · ')}</span>
          </div>
          <span className={`${statusClass} dshc-dialog-status-pill`} title={accountTitle}>{statusWithAccount}</span>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          <p className="dshc-dialog-body">{connector.description}</p>
          {connector.versionOutdated && (
            <p className="dshc-dialog-error">
              
              {tr("CLI 版本")} {connector.version ?? tr('未知')}  {tr("低于官方要求")} {connector.minVersion}{tr("，请用「更多 → 更新 CLI」升级。")}
            </p>
          )}
          {capabilities !== undefined && capabilities.items.length > 0 && (
            <section className="dshc-tools dshc-capabilities">
              <div className="dshc-tools-head dshc-capability-head">
                <h3>{tr("可用能力")}</h3>
                <span
                  className="dshc-tools-count"
                  title={capabilities.kind === 'products'
                    ? tr("{v0} 个命令", { v0: capabilities.total })
                    : capabilities.kind === 'groups'
                      ? tr("{v0} 个命令组", { v0: capabilities.total })
                      : tr("{v0} 个 Skills", { v0: capabilities.total })}
                >
                  {capabilities.kind === 'products'
                    ? tr("{v0} 个产品", { v0: capabilities.items.length })
                    : capabilities.kind === 'groups'
                      ? tr("{v0} 个命令组", { v0: capabilities.items.length })
                      : tr("{v0} 个 Skills", { v0: capabilities.total })}
                </span>
              </div>
              <div className="dshc-tool-list">
                {visibleCapabilities.map(item => (
                  <ToolRow
                    key={item.id}
                    name={item.name}
                    description={item.description}
                  />
                ))}
              </div>
              {capabilities.items.length > 4 && (
                <button
                  type="button"
                  className="dshc-tools-toggle"
                  onClick={() => setShowAllCapabilities(current => !current)}
                >
                  {showAllCapabilities ? tr('收起') : tr("展开全部 {v0} 个", { v0: capabilities.items.length })}
                </button>
              )}
            </section>
          )}
          {connector.examples.length > 0 && (
            <section className="dshc-examples">
              <h3>{tr("试试这样用")}</h3>
              <div className="dshc-example-list">
                {connector.examples.map((example, index) => (
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
                        aria-label={tr("复制示例：{v0}", { v0: example })}
                        onMouseEnter={event => showExampleTip(event.currentTarget, index, 'copy')}
                        onMouseLeave={() => setExampleTip(null)}
                        onFocus={event => showExampleTip(event.currentTarget, index, 'copy')}
                        onBlur={() => setExampleTip(null)}
                        onClick={() => copy(example, index)}
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
                        aria-label={tr("去试试：{v0}", { v0: example })}
                        disabled={!canTry}
                        onMouseEnter={event => showExampleTip(event.currentTarget, index, 'try')}
                        onMouseLeave={() => setExampleTip(null)}
                        onFocus={event => showExampleTip(event.currentTarget, index, 'try')}
                        onBlur={() => setExampleTip(null)}
                        onClick={() => onTrial(example)}
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
          {connector.installed && (
            <button
              type="button"
              className="dshc-btn dshc-btn-md dshc-btn-ghost dshc-btn-danger"
              disabled={busy}
              onClick={onUninstall}
            >
              
              {tr("卸载 CLI")}
            </button>
          )}
          <span className="dshc-dialog-actions-right">
            {!connector.installed ? (
              <>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>{tr("关闭")}</button>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled={busy} onClick={onInstall}>{tr("安装")}</button>
              </>
            ) : !connector.authenticated ? (
              <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled={busy} onClick={onLogin}>{tr("登录")}</button>
            ) : (
              <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" onClick={onClose}>{tr("完成")}</button>
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

interface CliErrorDialogProps {
  connector: CliConnectorView
  onClose: () => void
}

function CliErrorDialog({ connector, onClose }: CliErrorDialogProps): JSX.Element {
  const [log, setLog] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError(null)
    void (async () => {
      try {
        const response = await request<CliLogPayload>(`${ROUTE_PREFIX}/api/cli/${encodeURIComponent(connector.id)}/log`)
        if (active) setLog(response.value.output)
      } catch (cause) {
        if (active) setLoadError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [connector.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const fullText = [connector.lastError ?? '', log.trim()].filter(text => text !== '').join('\n\n')
  const copy = (): void => {
    if (fullText === '') return
    void (async () => {
      try {
        await writeClipboard(fullText)
        setCopied(true)
        setCopyFailed(false)
        window.setTimeout(() => setCopied(false), 1500)
      } catch {
        setCopied(false)
        setCopyFailed(true)
        window.setTimeout(() => setCopyFailed(false), 2000)
      }
    })()
  }

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dshc-dialog dshc-dialog-detail" role="dialog" aria-modal="true" aria-label={tr("{v0} 错误日志", { v0: connector.name })}>
        <div className="dshc-dialog-head dshc-dialog-head-detail">
          <span className="dshc-avatar dshc-dialog-avatar dshc-dialog-avatar-lg"><IconAlert size={20} /></span>
          <div className="dshc-dialog-title">
            <h2>{tr("错误日志")}</h2>
            <span>{connector.name} · CLI</span>
          </div>
          <span className="dshc-status-pill dshc-status-pill-error dshc-dialog-status-pill">{tr("处理失败")}</span>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          <p className="dshc-dialog-error">{connector.lastError ?? tr('CLI 处理失败，未返回错误摘要。')}</p>
          <section className="dshc-cli-log-section">
            <div className="dshc-tools-head">
              <h3>{tr("运行日志")}</h3>
              {!loading && log.trim() !== '' && <span className="dshc-tools-count">{log.split(/\r?\n/).length}  {tr("行")}</span>}
            </div>
            {loading
              ? <p className="dshc-dialog-hint"><Spinner inline />  {tr("正在读取日志…")}</p>
              : loadError !== null
                ? <p className="dshc-dialog-error">{loadError}</p>
                : log.trim() === ''
                  ? <p className="dshc-dialog-hint">{tr("本次错误没有留下更多运行日志。")}</p>
                  : <pre className="dshc-cli-log">{log}</pre>}
          </section>
        </div>
        <div className="dshc-dialog-actions">
          <button
            type="button"
            className="dshc-btn dshc-btn-md dshc-btn-ghost"
            disabled={loading || fullText === ''}
            onClick={copy}
          >
            {copied ? <IconCheck size={14} /> : copyFailed ? <IconAlert size={14} /> : <IconCopy size={14} />}
            {copied ? tr('已复制') : copyFailed ? tr('复制失败') : tr('复制日志')}
          </button>
          <span className="dshc-dialog-actions-right">
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" onClick={onClose}>{tr("关闭")}</button>
          </span>
        </div>
      </div>
    </div>
  )
}

function CliLogo({ connector, size }: { connector: CliConnectorView; size: number }): JSX.Element {
  const src = CLI_ICONS[connector.id]
  return src === undefined
    ? <span className="dshc-logo-fallback" style={{ width: size, height: size }}>{connector.name.slice(0, 1)}</span>
    : <img className="dshc-logo-img" width={size} height={size} src={src} alt="" />
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
  connecting: boolean
  onOpen: () => void
  onInstall: () => void
  onAuthorize: () => void
  onCancelAuthorize: () => void
  onUpdateCredential?: () => void
  onReauthorize?: () => void
  onReconfigureInstance?: () => void
  onRevoke?: () => void
  onTrial: () => void
  onToggle: (enabled: boolean) => void
  onDisconnect: () => void
  onDelete?: () => void
  onEditCustom?: () => void
}

function ConnectorCardView({ card, connection, errorMessage, togglePending, authorizing, installing, connecting, onOpen, onInstall, onAuthorize, onCancelAuthorize, onUpdateCredential, onReauthorize, onReconfigureInstance, onRevoke, onTrial, onToggle, onDisconnect, onDelete, onEditCustom }: CardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuAbove, setMenuAbove] = useState(false)
  const [tip, setTip] = useState<CardTip | null>(null)
  const menuRef = useRef<HTMLSpanElement>(null)
  const connected = connection !== undefined && connection.authorized && connection.enabled && connection.error === undefined
  const unauthorized = connection !== undefined && !connection.authorized
  const toolCount = connection?.tools.length ?? 0
  const error = connection?.error ?? errorMessage
  const enabled = connection?.enabled === true

  const toggleMenu = (button: HTMLElement): void => {
    const rect = button.getBoundingClientRect()
    setMenuAbove(rect.bottom + 170 > window.innerHeight)
    setMenuOpen(current => !current)
  }

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
  const instancePending = card.instance !== undefined
    && connection !== undefined
    && connection.instanceReady !== true
  const actionText = connecting ? tr('连接中…') : error ?? (connection === undefined
    ? tr('查看详情')
    : unauthorized
      ? (instancePending ? tr('待配置') : tr('未授权'))
      : !enabled
        ? tr('已停用')
        : toolCount > 0
          ? tr("已连接 · {v0} 个工具\n{v1}", { v0: toolCount, v1: connection.tools.join('\n') })
          : tr('已连接 · 注册中'))
  const installActionClass = installing
    ? 'dshc-card-action dshc-card-action-connect dshc-card-action-loading'
    : 'dshc-card-action dshc-card-action-connect'
  const installLabel = installing ? tr('安装中…') : error !== undefined ? tr('重试') : tr('安装')
  const stateLabel = connecting
    ? tr('，连接中')
    : error !== undefined
      ? tr('，连接失败')
      : connection === undefined
        ? ''
        : unauthorized
          ? (instancePending ? tr('，待配置') : tr('，未授权'))
          : !enabled
            ? tr('，已停用')
            : toolCount > 0 ? tr("，已连接，{v0} 个工具", { v0: toolCount }) : tr('，已连接，正在注册工具')
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
      
      {tr("删除")}
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
      
      {tr("断开")}
    </button>
  )
  const reconfigureItem = onReconfigureInstance === undefined ? null : (
    <button
      type="button"
      role="menuitem"
      className="dshc-menu-item"
      disabled={authorizing}
      onClick={() => {
        setMenuOpen(false)
        onReconfigureInstance()
      }}
    >
      <IconServer size={14} />
      
      {tr("更换")}{instanceNoun(card)}
    </button>
  )
  const editItem = onEditCustom === undefined ? null : (
    <button
      type="button"
      role="menuitem"
      className="dshc-menu-item"
      disabled={authorizing}
      onClick={() => {
        setMenuOpen(false)
        onEditCustom()
      }}
    >
      <IconPencil size={14} />
      
      {tr("编辑配置")}
    </button>
  )

  return (
    <>
      <article
        className={menuOpen ? 'dshc-card dshc-card-menu-open' : 'dshc-card'}
      role="button"
      tabIndex={0}
      aria-label={tr("查看 {v0}{v1}", { v0: card.name, v1: stateLabel })}
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
        <span className="dshc-badge">{card.categoryLabel ?? tr(card.category)}</span>
        {connection === undefined ? (
          <span className="dshc-card-install-actions">
            {onDelete !== undefined && (
              <span className="dshc-card-more-wrap dshc-card-more-float" ref={menuRef}>
                <button
                  type="button"
                  className="dshc-card-more"
                  aria-label={tr("{v0} 更多操作", { v0: card.name })}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={event => {
                    event.stopPropagation()
                    toggleMenu(event.currentTarget)
                  }}
                >
                  <IconMore size={16} />
                </button>
                {menuOpen && (
                  <span className={menuAbove ? 'dshc-menu dshc-menu-above' : 'dshc-menu'} role="menu" onClick={event => event.stopPropagation()}>
                    {editItem}
                    {deleteItem}
                  </span>
                )}
              </span>
            )}
            <button
              type="button"
              className={installActionClass}
              title={installLabel}
              aria-label={installing ? tr("正在安装 {v0}", { v0: card.name }) : `${installLabel} ${card.name}`}
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
              aria-label={authorizing
                ? tr("取消授权 {v0}", { v0: card.name })
                : connecting
                  ? tr("正在连接 {v0}", { v0: card.name })
                  : `${instancePending ? tr('配置') : tr('授权')} ${card.name}`}
              disabled={connecting}
              onClick={event => {
                event.stopPropagation()
                if (authorizing) onCancelAuthorize()
                else if (!connecting) onAuthorize()
              }}
            >
              {(authorizing || connecting) && <Spinner inline />}
              {authorizing ? tr('取消授权') : connecting ? tr('连接中…') : (instancePending ? tr('配置') : tr('授权'))}
            </button>
            <span
              className="dshc-card-installed"
              role="img"
              aria-label={instancePending ? tr('已安装，待配置') : tr('已安装，待授权')}
              title={instancePending ? tr('已安装，待配置') : tr('已安装，待授权')}
            >
              <IconCheck size={14} />
            </span>
            <span className="dshc-card-more-wrap" ref={menuRef}>
              <button
                type="button"
                className="dshc-card-more"
                aria-label={tr("{v0} 更多操作", { v0: card.name })}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={event => {
                  event.stopPropagation()
                  toggleMenu(event.currentTarget)
                }}
              >
                <IconMore size={16} />
              </button>
              {menuOpen && (
                <span className={menuAbove ? 'dshc-menu dshc-menu-above' : 'dshc-menu'} role="menu" onClick={event => event.stopPropagation()}>
                  {reconfigureItem}
                  {editItem}
                  {disconnectItem}
                  {deleteItem}
                </span>
              )}
            </span>
          </span>
        ) : (
          <span className="dshc-card-actions">
            <span className={`${actionClass} dshc-card-status`} title={connecting ? tr('连接中…') : authorizing ? tr('授权中…') : actionText} aria-hidden>
              {(authorizing || connecting)
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
                  aria-label={tr("{v0} 更多操作", { v0: card.name })}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={event => {
                    event.stopPropagation()
                    toggleMenu(event.currentTarget)
                  }}
                >
                  <IconMore size={16} />
                </button>
                {menuOpen && (
                  <span className={menuAbove ? 'dshc-menu dshc-menu-above' : 'dshc-menu'} role="menu" onClick={event => event.stopPropagation()}>
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
                      
                      {tr("去试试")}
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
                        
                        {tr("更新令牌")}
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
                        
                        {tr("重新授权")}
                      </button>
                    )}
                    {reconfigureItem}
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
                        
                        {tr("取消授权")}
                      </button>
                    )}
                    {editItem}
                    {disconnectItem}
                    {deleteItem}
                  </span>
                )}
              </span>
              {togglePending
                ? <span className="dshc-card-toggle" role="status" aria-label={tr("处理中")}>
                    <Spinner />
                  </span>
                : <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={enabled ? tr("停用 {v0}", { v0: card.name }) : tr("启用 {v0}", { v0: card.name })}
                    title={enabled ? tr('停用') : tr('启用')}
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
  connecting: boolean
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
  onConfigureInstance: () => void
  onAuthorize: () => void
  onReauthorize: () => void
  onReconfigureInstance?: () => void
  onUpdateCredential: () => void
  onCancelAuthorize: () => void
  onTryExample: (example: string) => void
  onRevoke: () => void
  onDisconnect: () => void
  onToggle: (enabled: boolean) => void
  onDelete?: () => void
  onEditCustom?: () => void
}

function ConnectorDialog({ card, connection, pending, toggling, authorizing, connecting, authorizeLink, installOpen, error, behind = false, escLocked = false, onClose, onBeginInstall, onCancelInstall, onConnect, onInstallOAuth, onConfigureInstance, onAuthorize, onReauthorize, onReconfigureInstance, onUpdateCredential, onCancelAuthorize, onTryExample, onRevoke, onDisconnect, onToggle, onDelete, onEditCustom }: ConnectorDialogProps): JSX.Element {
  const [copied, setCopied] = useState<number | null>(null)
  const [copyFailed, setCopyFailed] = useState<number | null>(null)
  const [showAllTools, setShowAllTools] = useState(false)
  const [toolQuery, setToolQuery] = useState('')
  const toolSearchRef = useRef<HTMLInputElement>(null)
  const [exampleTip, setExampleTip] = useState<{
    index: number
    action: 'copy' | 'try'
    left: number
    top: number
    above: boolean
  } | null>(null)
  useEffect(() => {
    setToolQuery('')
  }, [card.id])

  const needsToken = isTokenCard(card)
  const oauth = isOAuthCard(card)
  const unauthorized = connection !== undefined && !connection.authorized
  const instancePending = card.instance !== undefined
    && connection !== undefined
    && connection.instanceReady !== true
  const disabled = connection !== undefined && connection.authorized && !connection.enabled
  const connected = connection !== undefined && connection.authorized && connection.enabled && connection.error === undefined
  const noneConnecting = connecting && !oauth && !needsToken
  const toolDetails: ToolInfo[] = connection?.toolDetails ?? (connection?.tools ?? []).map(name => ({ name }))
  const canTry = connected && toolDetails.length > 0
  const visibleTools = showAllTools ? toolDetails : toolDetails.slice(0, 4)
  const toolQueryText = toolQuery.trim().toLowerCase()
  const filteredTools = toolQueryText === ''
    ? toolDetails
    : toolDetails.filter(tool => `${shortToolName(tool.name, connection?.serverName)} ${tool.name} ${tool.description ?? ''}`
      .toLowerCase()
      .includes(toolQueryText))
  const shownTools = toolQueryText === '' ? visibleTools : filteredTools
  const examples = card.examples ?? []
  const instance = card.instance
  const showingInstall = installOpen && instance === undefined && connection === undefined && !needsToken
  const needsInstanceConfig = instance !== undefined
    && connection !== undefined
    && !connection.authorized
    && connection.instanceReady !== true
  const busy = pending || toggling
  const removeLabel = onDelete === undefined ? tr('删除') : tr('断开')
  const removingLabel = onDelete === undefined ? tr('删除中…') : tr('断开中…')
  const removeClass = onDelete === undefined
    ? 'dshc-btn dshc-btn-md dshc-btn-outline dshc-btn-danger'
    : 'dshc-btn dshc-btn-md dshc-btn-outline'

  useEffect(() => {
    setCopied(null)
    setCopyFailed(null)
    setShowAllTools(false)
  }, [card.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !escLocked) onClose()
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
      ? tr('去试试')
      : copied === exampleTip.index
        ? tr('已复制')
        : copyFailed === exampleTip.index
          ? tr('复制失败')
          : tr('复制')

  const statusText = connecting && connection !== undefined && connection.error === undefined
    ? tr('连接中')
    : connection === undefined
      ? tr('未连接')
      : unauthorized
        ? (authorizing ? tr('授权中') : instancePending ? tr('待配置') : tr('未授权'))
        : disabled
          ? tr('已停用')
          : connected
            ? tr('已连接')
            : tr('连接失败')
  const statusClass = connection === undefined || unauthorized || disabled
    ? 'dshc-status-pill'
    : connected
      ? 'dshc-status-pill dshc-status-pill-connected'
      : 'dshc-status-pill dshc-status-pill-error'

  return (
    <div
      className={behind ? 'dshc-overlay dshc-overlay-behind' : 'dshc-overlay'}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dshc-dialog dshc-dialog-detail" role="dialog" aria-modal="true" aria-label={card.name}>
        <div className="dshc-dialog-head dshc-dialog-head-detail">
          <span className="dshc-avatar dshc-dialog-avatar dshc-dialog-avatar-lg"><ConnectorLogo card={card} /></span>
          <div className="dshc-dialog-title">
            <h2>{card.name}</h2>
            <span>{[card.vendor, card.categoryLabel ?? tr(card.category)].filter(Boolean).join(' · ')}</span>
          </div>
          <span className={`${statusClass} dshc-dialog-status-pill`}>{statusText}</span>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>

        <div className="dshc-dialog-content">
          <p className="dshc-dialog-body">{card.description ?? card.summary}</p>
          {connection?.error !== undefined && <p className="dshc-dialog-error">{connection.error}</p>}

          {needsInstanceConfig && (
            <p className="dshc-dialog-hint">
              {card.instance?.presets === undefined
                ? tr("点击「配置」填写完整的 MCP 地址；地址只保存在本机。")
                : tr("点击「配置」选择{v0}；选择结果只保存在本机。", { v0: instanceNoun(card) })}
            </p>
          )}

          {needsToken && connection !== undefined && !connection.authorized && !needsInstanceConfig && (
            <p className="dshc-dialog-hint">{tr("点击「授权」后填写")} {tokenLabel(card)}{tr("；令牌只保存在本机。")}</p>
          )}
          {needsToken && connection?.authorized === true && connection.error !== undefined && (
            <p className="dshc-dialog-hint">{tr("点击「更新令牌」重新填写")} {tokenLabel(card)}。</p>
          )}
          {oauth && connection === undefined && !showingInstall && (
            <p className="dshc-dialog-hint">{tr("点击「安装」后会打开默认浏览器完成")} {card.name}  {tr("授权。")}</p>
          )}
          {oauth && unauthorized && (
            <p className="dshc-dialog-hint">
              {authorizing
                ? tr('已打开授权页，完成授权后会自动同步；如已关闭授权页，请点「取消授权」后重试。')
                : needsInstanceConfig
                  ? tr("已安装，点击「配置」选择{v0}后开始授权。", { v0: instanceNoun(card) })
                  : tr("已安装，点击授权后在浏览器完成 {v0} 授权。", { v0: card.name })}
            </p>
          )}
          {authorizeLink !== null && authorizing && (
            <p className="dshc-dialog-hint">
              
              {tr("没有自动打开浏览器？")}
              <a className="dshc-link" href={authorizeLink} target="_blank" rel="noreferrer">{tr("点此授权")}</a>
            </p>
          )}
          {error !== null && error !== connection?.error && <p className="dshc-dialog-error">{error}</p>}

          {toolDetails.length > 0 && (
            <section className="dshc-tools">
              <div className="dshc-tools-head">
                <h3>{tr("可用工具")}</h3>
                <span className="dshc-tools-count">
                  {toolQueryText === '' ? toolDetails.length : `${filteredTools.length}/${toolDetails.length}`}
                </span>
                <span className="dshc-tools-search-wrap">
                  <input
                    ref={toolSearchRef}
                    className="dshc-tools-search"
                    name="dsh-connector-tool-search"
                    type="text"
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    data-bwignore="true"
                    spellCheck={false}
                    aria-label={tr("搜索工具")}
                    placeholder={tr("搜索工具")}
                    value={toolQuery}
                    onChange={event => setToolQuery(event.target.value)}
                  />
                  {toolQuery !== '' && (
                    <button
                      type="button"
                      className="dshc-tools-search-clear"
                      aria-label={tr('清空搜索')}
                      title={tr('清空搜索')}
                      onClick={() => {
                        setToolQuery('')
                        toolSearchRef.current?.focus()
                      }}
                    >
                      <IconClose size={12} />
                    </button>
                  )}
                </span>
              </div>
              <div className="dshc-tool-list">
                {shownTools.map(tool => (
                  <ToolRow
                    key={tool.name}
                    name={shortToolName(tool.name, connection?.serverName)}
                    description={tool.description}
                  />
                ))}
                {toolQueryText !== '' && filteredTools.length === 0 && (
                  <p className="dshc-tools-empty">{tr("没有匹配的工具")}</p>
                )}
              </div>
              {toolQueryText === '' && toolDetails.length > 4 && (
                <button
                  type="button"
                  className="dshc-tools-toggle"
                  onClick={() => setShowAllTools(current => !current)}
                >
                  {showAllTools ? tr('收起') : tr("展开全部 {v0} 个", { v0: toolDetails.length })}
                </button>
              )}
            </section>
          )}
          {disabled && <p className="dshc-dialog-hint">{tr("已停用，启用后会重新注册工具。")}</p>}
          {connected && toolDetails.length === 0 && (
            <p className="dshc-dialog-hint">{connecting ? tr('正在连接…') : tr('正在注册工具…')}</p>
          )}

          {examples.length > 0 && (
            <section className="dshc-examples">
              <h3>{tr("试试这样用")}</h3>
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
                        aria-label={tr("复制示例：{v0}", { v0: example })}
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
                        aria-label={tr("去试试：{v0}", { v0: example })}
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
              
              {tr("删除")}
            </button>
          )}
          {onEditCustom !== undefined && !authorizing && (
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost" disabled={busy} onClick={onEditCustom}>
              
              {tr("编辑配置")}
            </button>
          )}
          {onReconfigureInstance !== undefined && connection !== undefined && !authorizing && (
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost" disabled={busy} onClick={onReconfigureInstance}>
              
              {tr("更换")}{instanceNoun(card)}
            </button>
          )}
          {oauth && connection?.authorized === true && !authorizing && (
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost" disabled={busy} onClick={onRevoke}>
              
              {tr("取消授权")}
            </button>
          )}
          <span className="dshc-dialog-actions-right">
            {authorizing && connection?.authorized === true && (
              <>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onCancelAuthorize}>
                  
                  {tr("取消授权")}
                </button>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled>
                  <Spinner />
                  
                  {tr("授权中…")}
                </button>
              </>
            )}
            {unauthorized && (
              authorizing ? (
                <>
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onCancelAuthorize}>
                    
                    {tr("取消授权")}
                  </button>
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled>
                    <Spinner />
                    
                    {tr("授权中…")}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className={removeClass} disabled={busy} onClick={onDisconnect}>
                    {removeLabel}
                  </button>
                  {needsInstanceConfig ? (
                    <button
                      type="button"
                      className="dshc-btn dshc-btn-md dshc-btn-primary"
                      disabled={busy}
                      onClick={onConfigureInstance}
                    >
                      {pending && <Spinner />}
                      {pending ? tr('配置中…') : tr('配置')}
                    </button>
                  ) : oauth ? (
                    <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled={busy} onClick={onAuthorize}>
                      
                      {tr("授权")} {card.name}
                    </button>
                  ) : needsToken ? (
                    <button
                      type="button"
                      className="dshc-btn dshc-btn-md dshc-btn-primary"
                      disabled={busy}
                      onClick={onUpdateCredential}
                    >
                      {busy && <Spinner />}
                      {busy ? tr('连接中…') : tr("授权 {v0}", { v0: card.name })}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="dshc-btn dshc-btn-md dshc-btn-primary"
                      disabled={busy}
                      onClick={() => onConnect(undefined)}
                    >
                      {pending ? tr('连接中…') : tr('连接')}
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
                  {toggling ? tr('启用中…') : tr('启用')}
                </button>
              </>
            )}
            {!authorizing && connected && (
              noneConnecting ? (
                <>
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>
                    
                    {tr("取消")}
                  </button>
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled>
                    <Spinner />
                    
                    {tr("连接中…")}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className={removeClass} disabled={busy} onClick={onDisconnect}>
                    {pending && !connecting ? removingLabel : removeLabel}
                  </button>
                  {oauth && (
                    <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost" disabled={busy} onClick={onReauthorize}>
                      
                      {tr("重新授权")}
                    </button>
                  )}
                  {needsToken && (
                    <button type="button" className="dshc-btn dshc-btn-md dshc-btn-ghost" disabled={busy} onClick={onUpdateCredential}>
                      {pending && <Spinner />}
                      {pending ? tr('更新中…') : tr('更新令牌')}
                    </button>
                  )}
                  <button type="button" className="dshc-btn dshc-btn-md dshc-btn-primary" disabled={busy} onClick={onClose}>
                    {connecting && <Spinner />}
                    {connecting ? tr('连接中…') : tr('完成')}
                  </button>
                </>
              )
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
                    {pending ? tr('授权中…') : tr('重新授权')}
                  </button>
                ) : needsToken ? (
                  <button
                    type="button"
                    className="dshc-btn dshc-btn-md dshc-btn-primary"
                    disabled={busy}
                    onClick={onUpdateCredential}
                  >
                    {pending && <Spinner />}
                    {pending ? tr('更新中…') : tr('更新令牌')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="dshc-btn dshc-btn-md dshc-btn-primary"
                    disabled={busy}
                    onClick={() => onConnect(undefined)}
                  >
                    {pending ? tr('重试中…') : tr('重试')}
                  </button>
                )}
              </>
            )}
            {connection === undefined && showingInstall && (
              <>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" disabled={busy} onClick={onCancelInstall}>
                  
                  {tr("取消")}
                </button>
                {oauth && (
                  <button
                    type="button"
                    className="dshc-btn dshc-btn-md dshc-btn-primary"
                    disabled={busy}
                    onClick={onInstallOAuth}
                  >
                    {pending && <Spinner />}
                    {pending ? tr('安装中…') : tr('安装')}
                  </button>
                )}
              </>
            )}
            {connection === undefined && !showingInstall && (
              <>
                <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>
                  
                  {tr("关闭")}
                </button>
                <button
                  type="button"
                  className="dshc-btn dshc-btn-md dshc-btn-primary"
                  disabled={busy}
                  onClick={onBeginInstall}
                >
                  {pending && <Spinner />}
                  {pending ? tr('安装中…') : tr('安装')}
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

interface InstanceDialogProps {
  card: ConnectorCard
  mode: 'config' | 'replace'
  pending: boolean
  error: string | null
  onClose: () => void
  onSubmit: (instanceUrl: string) => void
}

function InstanceDialog({ card, mode, pending, error, onClose, onSubmit }: InstanceDialogProps): JSX.Element {
  const instance = card.instance
  const presets = instance?.presets
  const [instanceUrl, setInstanceUrl] = useState(presets?.[0]?.url ?? '')
  const config = mode === 'config'
  const noun = instanceNoun(card)
  const selectedPreset = presets?.find(item => item.url === instanceUrl)
  const title = presets === undefined
    ? (config ? tr('填写地址') : tr('更换地址'))
    : (config ? tr("选择{v0}", { v0: noun }) : tr("更换{v0}", { v0: noun }))
  const submitLabel = config
    ? (isOAuthCard(card) ? tr('保存并授权') : isTokenCard(card) ? tr('保存并继续') : tr('保存并连接'))
    : (isOAuthCard(card) ? tr('保存并重新授权') : isTokenCard(card) ? tr('保存') : tr('保存并重新连接'))
  const keepLocal = presets === undefined ? tr('地址只保存在本机。') : tr('选择结果只保存在本机。')
  const configHint = isOAuthCard(card)
    ? tr("保存后会自动打开浏览器完成授权；{v0}", { v0: keepLocal })
    : isTokenCard(card)
      ? tr("保存后继续填写令牌；{v0}", { v0: keepLocal })
      : tr("保存后直接连接；{v0}", { v0: keepLocal })

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pending])

  const submit = (): void => {
    if (pending || instanceUrl.trim() === '') return
    onSubmit(instanceUrl.trim())
  }

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !pending) onClose()
      }}
    >
      <form
        className="dshc-dialog dshc-dialog-instance"
        role="dialog"
        aria-modal="true"
        aria-label={`${config ? tr('填写') : tr('更换')} ${card.name} ${noun}`}
        noValidate
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="dshc-dialog-head">
          <span className="dshc-dialog-avatar"><ConnectorLogo card={card} size={28} /></span>
          <div className="dshc-dialog-title">
            <h2>{title}</h2>
            <span>{card.name}</span>
          </div>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} disabled={pending} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          <p className="dshc-dialog-hint">
            {config ? configHint : tr('更换后会断开当前连接、清除已有凭据，需要重新配置或授权。')}
          </p>
          <label className="dshc-field">
            <span>{instance?.label ?? tr('服务地址')}</span>
            {presets === undefined
              ? (
                  <input
                    autoFocus
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending}
                    placeholder={instance?.placeholder ?? 'https://gitlab.example.com'}
                    value={instanceUrl}
                    onChange={event => setInstanceUrl(event.target.value)}
                  />
                )
              : (
                  <span className="dshc-select">
                    <span className="dshc-select-control">
                      <select
                        autoFocus
                        disabled={pending}
                        value={instanceUrl}
                        onChange={event => setInstanceUrl(event.target.value)}
                      >
                        {presets.map(item => (
                          <option key={item.url} value={item.url}>{item.label}</option>
                        ))}
                      </select>
                      <span className="dshc-select-toggle dshc-select-toggle-static" aria-hidden="true">
                        <IconChevronDown size={14} />
                      </span>
                    </span>
                  </span>
                )}
          </label>
          {selectedPreset?.hint !== undefined && <p className="dshc-dialog-hint">{selectedPreset.hint}</p>}
          {instance?.hint !== undefined && <p className="dshc-dialog-hint">{instance.hint}</p>}
          {instance?.help !== undefined && (
            <p className="dshc-dialog-hint">
              <a className="dshc-link" href={instance.help.url} target="_blank" rel="noreferrer">
                {instance.help.label}
              </a>
              {instance.help.hint !== undefined && <span>　{instance.help.hint}</span>}
            </p>
          )}
          {presets === undefined && instanceUrl.trim().startsWith('http://') && (
            <p className="dshc-dialog-hint">{tr("非 https 地址会明文传输，请确认网络可信。")}</p>
          )}
          {error !== null && <p className="dshc-dialog-error">{error}</p>}
        </div>
        <div className="dshc-dialog-actions">
          <span className="dshc-dialog-actions-right">
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" disabled={pending} onClick={onClose}>
              {pending ? tr('关闭') : tr('取消')}
            </button>
            <button
              type="submit"
              className="dshc-btn dshc-btn-md dshc-btn-primary"
              disabled={pending || instanceUrl.trim() === ''}
            >
              {pending && <Spinner />}
              {pending ? tr('保存中…') : submitLabel}
            </button>
          </span>
        </div>
      </form>
    </div>
  )
}

interface CredentialDialogProps {
  card: ConnectorCard
  mode: 'install' | 'update'
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (token: string) => void
}

function CredentialDialog({ card, mode, saving, error, onClose, onSubmit }: CredentialDialogProps): JSX.Element {
  const [token, setToken] = useState('')
  const [tokenVisible, setTokenVisible] = useState(false)
  const help = tokenHelp(card)
  const title = mode === 'install' ? tr('填写令牌') : tr('更新令牌')
  const submitLabel = mode === 'install' ? tr('连接') : tr('保存')

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = (): void => {
    if (saving || token.trim() === '') return
    onSubmit(token)
  }

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="dshc-dialog dshc-dialog-credential"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'install' ? tr("填写 {v0} 令牌", { v0: card.name }) : tr("更新 {v0} 令牌", { v0: card.name })}
      >
        <div className="dshc-dialog-head">
          <span className="dshc-dialog-avatar"><ConnectorLogo card={card} size={28} /></span>
          <div className="dshc-dialog-title">
            <h2>{title}</h2>
            <span>{card.name}</span>
          </div>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          <p className="dshc-dialog-hint">
            {mode === 'install'
              ? tr("填写 {v0} 后连接；令牌只保存在本机。", { v0: tokenLabel(card) })
              : tr('当前令牌不会显示；保存新令牌后立即替换。')}
          </p>
          <div className="dshc-field">
            <label htmlFor="dshc-credential-token">{tokenLabel(card)}</label>
            <span className="dshc-field-control">
              <input
                id="dshc-credential-token"
                name="dsh-connector-token"
                type={tokenVisible ? 'text' : 'password'}
                autoFocus
                autoComplete="new-password"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                disabled={saving}
                placeholder={mode === 'install' ? tr('粘贴令牌') : tr('粘贴新令牌')}
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
                aria-label={tokenVisible ? tr('隐藏令牌') : tr('显示令牌')}
                title={tokenVisible ? tr('隐藏令牌') : tr('显示令牌')}
                aria-pressed={tokenVisible}
                disabled={saving}
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
          {saving && <p className="dshc-dialog-hint">{tr("关闭弹窗不会中断连接，结果会显示在卡片上。")}</p>}
        </div>
        <div className="dshc-dialog-actions">
          <span className="dshc-dialog-actions-right">
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>
              {saving ? tr('关闭') : tr('取消')}
            </button>
            <button
              type="button"
              className="dshc-btn dshc-btn-md dshc-btn-primary"
              disabled={saving || token.trim() === ''}
              onClick={submit}
            >
              {saving && <Spinner />}
              {saving ? (mode === 'install' ? tr('连接中…') : tr('保存中…')) : submitLabel}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

interface OAuthAppDialogProps {
  card: ConnectorCard
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (clientId: string, clientSecret: string) => void
}

function OAuthAppDialog({ card, saving, error, onClose, onSubmit }: OAuthAppDialogProps): JSX.Element {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [secretVisible, setSecretVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  const help = card.auth.type === 'oauth2' ? card.auth.help : undefined
  const callback = oauthRedirectUri(card)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = (): void => {
    if (saving || clientId.trim() === '' || clientSecret.trim() === '') return
    onSubmit(clientId.trim(), clientSecret.trim())
  }

  const copyCallback = (): void => {
    void navigator.clipboard.writeText(callback).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }).catch(() => undefined)
  }

  return (
    <div
      className="dshc-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dshc-dialog dshc-dialog-credential" role="dialog" aria-modal="true" aria-label={tr("配置 {v0} 应用", { v0: card.name })}>
        <div className="dshc-dialog-head">
          <span className="dshc-dialog-avatar"><ConnectorLogo card={card} size={28} /></span>
          <div className="dshc-dialog-title">
            <h2>{tr("配置 OAuth 应用")}</h2>
            <span>{card.name}</span>
          </div>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          <p className="dshc-dialog-hint">
            
            {tr("在")}{card.vendor ?? card.name}{tr("开放平台创建应用，把回调地址填到应用的安全设置里，再填入应用凭据；凭据只保存在本机。")}
          </p>
          <div className="dshc-field">
            <label htmlFor="dshc-oauth-callback">{tr("回调地址")}</label>
            <span className="dshc-field-control">
              <input id="dshc-oauth-callback" readOnly value={callback} onFocus={event => event.currentTarget.select()} />
              <button type="button" className="dshc-field-copy" onClick={copyCallback}>
                {copied ? tr('已复制') : tr('复制')}
              </button>
            </span>
          </div>
          <div className="dshc-field">
            <label htmlFor="dshc-oauth-client-id">AppKey</label>
            <span className="dshc-field-control">
              <input
                id="dshc-oauth-client-id"
                name="dsh-oauth-client-id"
                type="text"
                autoFocus
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                spellCheck={false}
                disabled={saving}
                placeholder={tr("应用 AppKey / Client ID")}
                value={clientId}
                onChange={event => setClientId(event.target.value)}
              />
            </span>
          </div>
          <div className="dshc-field">
            <label htmlFor="dshc-oauth-client-secret">SecretKey</label>
            <span className="dshc-field-control">
              <input
                id="dshc-oauth-client-secret"
                name="dsh-oauth-client-secret"
                type={secretVisible ? 'text' : 'password'}
                autoComplete="new-password"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                disabled={saving}
                placeholder={tr("应用 SecretKey / Client Secret")}
                value={clientSecret}
                onChange={event => setClientSecret(event.target.value)}
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
                aria-label={secretVisible ? tr('隐藏 SecretKey') : tr('显示 SecretKey')}
                title={secretVisible ? tr('隐藏 SecretKey') : tr('显示 SecretKey')}
                aria-pressed={secretVisible}
                disabled={saving}
                onMouseDown={event => event.preventDefault()}
                onClick={() => setSecretVisible(current => !current)}
              >
                {secretVisible ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
            </span>
          </div>
          {help !== undefined && (
            <p className="dshc-dialog-hint">
              <a className="dshc-link" href={help.url} target="_blank" rel="noreferrer">{help.label}</a>
              {help.hint !== undefined && <span>　{help.hint}</span>}
            </p>
          )}
          {error !== null && <p className="dshc-dialog-error">{error}</p>}
          {saving && <p className="dshc-dialog-hint">{tr("保存后会打开浏览器完成授权。")}</p>}
        </div>
        <div className="dshc-dialog-actions">
          <span className="dshc-dialog-actions-right">
            <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" onClick={onClose}>
              {saving ? tr('关闭') : tr('取消')}
            </button>
            <button
              type="button"
              className="dshc-btn dshc-btn-md dshc-btn-primary"
              disabled={saving || clientId.trim() === '' || clientSecret.trim() === ''}
              onClick={submit}
            >
              {saving && <Spinner />}
              {saving ? tr('保存中…') : tr('保存并授权')}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

interface CustomEditInfo {
  connectorId: string
  initial: CustomConfigView
}

interface CustomDialogProps {
  onClose: () => void
  categoryOptions: string[]
  onImported: (connectors: ConnectorCard[], connectNow: boolean) => void
  editing?: CustomEditInfo
  onEdited?: (result: CustomUpdatePayload['value']) => void
}

function CustomConnectorDialog({ onClose, categoryOptions, onImported, editing, onEdited }: CustomDialogProps): JSX.Element {
  const [json, setJson] = useState(editing?.initial.json ?? (currentLocale().toLowerCase().startsWith('en') ? MCP_SERVERS_PLACEHOLDER_EN : MCP_SERVERS_PLACEHOLDER))
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [examples, setExamples] = useState('')
  const [descriptionEn, setDescriptionEn] = useState('')
  const [categoryEn, setCategoryEn] = useState('')
  const [examplesEn, setExamplesEn] = useState('')
  const [metaLang, setMetaLang] = useState<'zh' | 'en'>(currentLocale().toLowerCase().startsWith('en') ? 'en' : 'zh')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [privateWarning, setPrivateWarning] = useState(false)
  const [privateConfirmed, setPrivateConfirmed] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [categoryMenu, setCategoryMenu] = useState<{ left: number; top: number; width: number } | null>(null)
  const [helpTip, setHelpTip] = useState<{
    left: number
    top: number
    above: boolean
    kind: 'import' | 'x-dsh'
  } | null>(null)
  const categoryRef = useRef<HTMLDivElement>(null)
  const categoryMenuRef = useRef<HTMLDivElement>(null)
  const categoryInputRef = useRef<HTMLInputElement>(null)
  const helpHideTimerRef = useRef<number | null>(null)
  const helpHoverRef = useRef(false)
  const parsedJson = useMemo<{
    count: number
    meta: { description?: string; category?: string; examples?: string[] } | null
    metaEn: { description?: string; category?: string; examples?: string[] } | null
  }>(() => {
    const readMeta = (value: unknown): { description?: string; category?: string; examples?: string[] } | null => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const record = value as Record<string, unknown>
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
      if (description === undefined && category === undefined && (examples === undefined || examples.length === 0)) {
        return null
      }
      return {
        ...(description === undefined ? {} : { description }),
        ...(category === undefined ? {} : { category }),
        ...(examples === undefined || examples.length === 0 ? {} : { examples }),
      }
    }
    try {
      const parsed = JSON.parse(json) as { mcpServers?: unknown }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { count: 0, meta: null, metaEn: null }
      }
      const servers = parsed.mcpServers
      if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
        return { count: 0, meta: null, metaEn: null }
      }
      const entries = Object.entries(servers)
      if (entries.length !== 1) return { count: entries.length, meta: null, metaEn: null }
      const server = entries[0]?.[1]
      if (server === null || typeof server !== 'object' || Array.isArray(server)) {
        return { count: 1, meta: null, metaEn: null }
      }
      const xdsh = (server as Record<string, unknown>)['x-dsh']
      if (xdsh === null || typeof xdsh !== 'object' || Array.isArray(xdsh)) {
        return { count: 1, meta: null, metaEn: null }
      }
      const record = xdsh as Record<string, unknown>
      const translations = record.translations
      const en = translations !== null && typeof translations === 'object' && !Array.isArray(translations)
        ? (translations as Record<string, unknown>).en
        : undefined
      return { count: 1, meta: readMeta(xdsh), metaEn: readMeta(en) }
    } catch {
      return { count: 0, meta: null, metaEn: null }
    }
  }, [json])
  const serverCount = parsedJson.count
  const jsonMeta = parsedJson.meta
  const previewMetaEn = parsedJson.metaEn
  const hasJsonMeta = jsonMeta !== null || previewMetaEn !== null
  const previewMeta = jsonMeta

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

  const showHelpTip = (element: HTMLElement, kind: 'import' | 'x-dsh'): void => {
    cancelHelpTipHide()
    const rect = element.getBoundingClientRect()
    const width = Math.min(380, window.innerWidth - 32)
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))
    const above = rect.bottom + 220 > window.innerHeight
    setHelpTip({ left, top: above ? rect.top - 8 : rect.bottom + 8, above, kind })
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
    const exampleLinesEn = parseExampleLines(examplesEn)
    const enTranslations = {
      ...(descriptionEn.trim() === '' ? {} : { description: descriptionEn.trim() }),
      ...(categoryEn.trim() === '' ? {} : { category: categoryEn.trim() }),
      ...(exampleLinesEn.length === 0 ? {} : { examples: exampleLinesEn }),
    }
    const translations = Object.keys(enTranslations).length === 0 ? undefined : { en: enTranslations }
    void (async () => {
      try {
        const body = JSON.stringify({
          json,
          allowPrivate: privateWarning,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
          ...(category.trim() === '' ? {} : { category: category.trim() }),
          ...(exampleLines.length === 0 ? {} : { examples: exampleLines }),
          ...(translations === undefined ? {} : { translations }),
        })
        if (editing !== undefined) {
          const response = await request<CustomUpdatePayload>(
            `${ROUTE_PREFIX}/api/custom-connectors/${encodeURIComponent(editing.connectorId)}`,
            { method: 'PUT', body },
          )
          onEdited?.(response.value)
          return
        }
        const response = await request<CustomConnectorsPayload>(`${ROUTE_PREFIX}/api/custom-connectors`, {
          method: 'POST',
          body,
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
        aria-label={editing === undefined ? tr('自定义连接器') : tr('编辑连接器配置')}
        onSubmit={event => {
          event.preventDefault()
          if (pending || json.trim() === '' || (privateWarning && !privateConfirmed)) return
          if (editing !== undefined) {
            if (serverCount === 1) submit(false)
            return
          }
          submit(serverCount === 1)
        }}
      >
        <div className="dshc-dialog-head">
          <div className="dshc-dialog-head-title">
            <h2>{editing === undefined ? tr('自定义连接器') : tr('编辑配置')}</h2>
            {editing === undefined && (
              <button
                type="button"
                className="dshc-help-btn"
                aria-label={tr("自定义连接器说明")}
                onMouseEnter={event => showHelpTip(event.currentTarget, 'import')}
                onMouseLeave={hideHelpTipSoon}
                onFocus={event => showHelpTip(event.currentTarget, 'import')}
                onBlur={hideHelpTipSoon}
              >
                <IconHelp size={14} />
              </button>
            )}
          </div>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} disabled={pending} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          {editing?.initial.installed === true && (
            <p className="dshc-dialog-hint">
              
              {tr("当前已安装；如修改地址、命令、请求头或环境变量，保存后会断开连接，需要重新安装。")}
            </p>
          )}
          <div className="dshc-field">
            <span className="dshc-field-label">
              <span>mcpServers JSON</span>
              <button
                type="button"
                className="dshc-help-btn"
                aria-label={tr("x-dsh 说明")}
                onMouseEnter={event => showHelpTip(event.currentTarget, 'x-dsh')}
                onMouseLeave={hideHelpTipSoon}
                onFocus={event => showHelpTip(event.currentTarget, 'x-dsh')}
                onBlur={hideHelpTipSoon}
              >
                <IconHelp size={14} />
              </button>
            </span>
            <JsonEditor
              value={json}
              onChange={value => {
                setJson(value)
                setPrivateWarning(false)
                setPrivateConfirmed(false)
                setError(null)
              }}
            />
          </div>
          {editing !== undefined && (
            <p className="dshc-dialog-hint">
              
              {tr("修改会保存到本机；密钥与 URL 查询参数不会回显，保持")} {CUSTOM_SECRET_PLACEHOLDER}  {tr("会沿用原值。")}
            </p>
          )}
          {hasJsonMeta && (
            <p className="dshc-dialog-hint">{tr("已读取 JSON 中的 x-dsh；下方留空就使用它，填写会覆盖。")}</p>
          )}
          <div className="dshc-meta-lang">
            <span>{tr('卡片文案')}</span>
            <div className="dshc-lang-switch" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={metaLang === 'zh'}
                className={metaLang === 'zh' ? 'dshc-lang-option dshc-lang-option-active' : 'dshc-lang-option'}
                onClick={() => setMetaLang('zh')}
              >
                中文
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={metaLang === 'en'}
                className={metaLang === 'en' ? 'dshc-lang-option dshc-lang-option-active' : 'dshc-lang-option'}
                onClick={() => setMetaLang('en')}
              >
                English
              </button>
            </div>
          </div>
          <div hidden={metaLang !== 'zh'}>
          <label className="dshc-field">
            <span>{tr("描述（可选）")}</span>
            <input
              autoComplete="off"
              maxLength={120}
              placeholder={previewMeta?.description === undefined
                ? tr('例如：通过 DeepWiki 查询仓库结构与文档')
                : tr("JSON 中：{v0}", { v0: previewMeta.description })}
              value={description}
              onChange={event => setDescription(event.target.value)}
            />
          </label>
          <div className="dshc-field">
            <span className="dshc-field-label">
              <span>{tr("类别（可选）")}</span>
            </span>
            <div className="dshc-select" ref={categoryRef}>
              <div className="dshc-select-control">
                <input
                  ref={categoryInputRef}
                  autoComplete="off"
                  placeholder={previewMeta?.category === undefined ? tr('默认：其他') : tr("JSON 中：{v0}", { v0: previewMeta.category })}
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
                  aria-label={tr("选择类别")}
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
              {previewMeta?.category === undefined
                ? tr('留空会归入「其他」；可直接输入新类别。')
                : tr('留空使用 JSON 中的类别；填写会覆盖。')}
            </p>
          </div>
          <label className="dshc-field">
            <span>{tr("示例提示词（可选，每行一条）")}</span>
            <textarea
              className="dshc-examples-input"
              spellCheck={false}
              placeholder={previewMeta?.examples === undefined
                ? tr('用 DeepWiki 查一下 facebook/react 的仓库结构')
                : tr("JSON 中：\n{v0}", { v0: previewMeta.examples.join('\n') })}
              value={examples}
              onChange={event => setExamples(event.target.value)}
            />
          </label>
          </div>
          <div hidden={metaLang !== 'en'}>
            <label className="dshc-field">
              <span>{tr('英文描述（可选）')}</span>
              <input
                autoComplete="off"
                maxLength={120}
                placeholder={previewMetaEn?.description === undefined
                  ? tr('留空使用中文描述')
                  : tr("JSON 中：{v0}", { v0: previewMetaEn.description })}
                value={descriptionEn}
                onChange={event => setDescriptionEn(event.target.value)}
              />
            </label>
            <label className="dshc-field">
              <span>{tr('英文分类显示名（可选）')}</span>
              <input
                autoComplete="off"
                maxLength={64}
                placeholder={previewMetaEn?.category === undefined
                  ? tr('留空使用中文分类')
                  : tr("JSON 中：{v0}", { v0: previewMetaEn.category })}
                value={categoryEn}
                onChange={event => setCategoryEn(event.target.value)}
              />
              <p className="dshc-dialog-hint">{tr('仅用于显示，不改变分类分组。')}</p>
            </label>
            <label className="dshc-field">
              <span>{tr('英文示例提示词（可选，每行一条）')}</span>
              <textarea
                className="dshc-examples-input"
                spellCheck={false}
                placeholder={previewMetaEn?.examples === undefined
                  ? tr('留空使用中文示例')
                  : tr("JSON 中：\n{v0}", { v0: previewMetaEn.examples.join('\n') })}
                value={examplesEn}
                onChange={event => setExamplesEn(event.target.value)}
              />
            </label>
          </div>
          {editing === undefined && serverCount > 1 && (
            <p className="dshc-warning">
              
              {tr("检测到")} {serverCount}  {tr("个 Server；多 Server 请用「仅导入」，导入后分别连接。")}
              {tr("填写下方描述、类别、示例会覆盖所有 Server；留空则各 Server 使用自己的 x-dsh。")}
            </p>
          )}
          {editing !== undefined && json.trim() !== '' && serverCount !== 1 && (
            <p className="dshc-warning">
              
              {tr("编辑时只能保留一个 Server，当前检测到")} {serverCount}  {tr("个。")}
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
                
                {tr("我确认允许访问本机或内网地址")}
              </label>
            </>
          )}
        </div>
        {error !== null && !privateWarning && (
          <div className="dshc-dialog-alert" role="alert">{error}</div>
        )}
        <div className="dshc-dialog-actions">
          <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" disabled={pending} onClick={onClose}>
            
            {tr("取消")}
          </button>
          {editing === undefined ? (
            <>
              <button
                type="button"
                className="dshc-btn dshc-btn-md dshc-btn-outline"
                disabled={pending || json.trim() === '' || (privateWarning && !privateConfirmed)}
                onClick={() => submit(false)}
              >
                {privateWarning ? tr('仍然仅导入') : tr('仅导入')}
              </button>
              <button
                type="submit"
                className="dshc-btn dshc-btn-md dshc-btn-primary"
                disabled={pending || json.trim() === '' || serverCount !== 1 || (privateWarning && !privateConfirmed)}
              >
                {pending ? tr('导入中…') : privateWarning ? tr('仍然导入并连接') : tr('导入并连接')}
              </button>
            </>
          ) : (
            <button
              type="submit"
              className="dshc-btn dshc-btn-md dshc-btn-primary"
              disabled={pending || json.trim() === '' || serverCount !== 1 || (privateWarning && !privateConfirmed)}
            >
              {pending && <Spinner />}
              {pending ? tr('保存中…') : tr('保存')}
            </button>
          )}
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
              {tr(item)}
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
          {helpTip.kind === 'import' ? (
            <>
              <strong>{tr("自定义连接器")}</strong>
              <span>{tr("粘贴 mcpServers JSON，支持 Streamable HTTP、SSE 与 stdio 三类 MCP Server。")}</span>
            </>
          ) : (
            <>
              <strong>{tr("可选扩展：x-dsh")}</strong>
              <span>{tr("可在每个 server 配置里指定描述、类别与示例，并用 translations.en 提供英文副本；优先于下方表单：")}</span>
              <code>{currentLocale().toLowerCase().startsWith('en') ? X_DSH_SAMPLE_EN : `"x-dsh": {
  "description": "查询仓库结构与文档",
  "category": "知识检索",
  "examples": ["用 DeepWiki 查 facebook/react 的仓库结构"],
  "translations": {
    "en": {
      "description": "Inspect repository structure and docs",
      "category": "Search & knowledge",
      "examples": ["Use DeepWiki to inspect facebook/react"]
    }
  }
}`}</code>
            </>
          )}
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
      <div className="dshc-dialog" role="dialog" aria-modal="true" aria-label={tr("删除 {v0}", { v0: card.name })}>
        <div className="dshc-dialog-head">
          <h2>{tr("删除")} {card.name}</h2>
          <button type="button" className="dshc-icon-btn" aria-label={tr("关闭")} disabled={pending} onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="dshc-dialog-content">
          <p className="dshc-dialog-body">{tr("这个自定义连接器会从本机移除，已保存的配置与凭据会一起删除，已连接的工具会注销。")}</p>
          {error !== null && <p className="dshc-dialog-error">{error}</p>}
        </div>
        <div className="dshc-dialog-actions">
          <button type="button" className="dshc-btn dshc-btn-md dshc-btn-outline" disabled={pending} onClick={onClose}>
            
            {tr("取消")}
          </button>
          <button
            type="button"
            className="dshc-btn dshc-btn-md dshc-btn-outline dshc-btn-danger"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? tr('删除中…') : tr('删除')}
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
  padding:0 clamp(24px,4vw,48px);
  background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);
  font:14px/22px var(--dsw-font-family);
}
.dshc-root.dshc-flow-root{height:0;overflow:visible;padding:0;background:transparent;pointer-events:none}
.dshc-flow-root .dshc-inner{display:none}
.dshc-flow-root .dshc-overlay{pointer-events:auto}
.dshc-inner{box-sizing:border-box;max-width:960px;margin:0 auto;padding:28px 0 48px}
.dshc-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
.dshc-header h1{margin:0;font-size:20px;font-weight:500;line-height:28px;color:var(--dsw-alias-label-primary)}
.dshc-search{box-sizing:border-box;display:flex;align-items:center;gap:6px;height:36px;margin:0 0 16px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary);cursor:text;transition:border-color .15s}
.dshc-search:hover{border-color:var(--dsw-alias-border-l2)}
.dshc-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.dshc-search input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
.dshc-search input::placeholder{color:var(--dsw-alias-label-caption)}
.dshc-search-clear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshc-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;text-decoration:none;cursor:pointer}
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
.dshc-tabs{display:flex;flex-wrap:nowrap;align-items:center;gap:8px 12px;margin-bottom:14px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;padding-bottom:2px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.dshc-tabs::-webkit-scrollbar{height:6px}
.dshc-tabs::-webkit-scrollbar-thumb{border-radius:999px;background:var(--dsw-alias-scrollbar-bg-l2)}
.dshc-tabs::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}
.dshc-tabs .dshc-tab{flex:none}
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
button.dshc-card-action{padding:0;border:0;background:transparent;cursor:pointer}
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
.dshc-card-actions-busy .dshc-card-controls{width:28px;opacity:1;pointer-events:auto}
.dshc-card:hover .dshc-card-actions-busy .dshc-card-controls,.dshc-card:focus-within .dshc-card-actions-busy .dshc-card-controls,.dshc-card-menu-open .dshc-card-actions-busy .dshc-card-controls{width:28px;opacity:1;pointer-events:auto}
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
.dshc-menu-above{top:auto;bottom:calc(100% + 6px)}
.dshc-cli-commands{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:12px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.dshc-cli-wait{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshc-cli-code{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dshc-cli-code code{font:12px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:2px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-3)}
.dshc-cli-output{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshc-cli-output summary{cursor:pointer}
.dshc-cli-output pre{max-height:140px;margin:6px 0 0;padding:8px;overflow:auto;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.dshc-cli-log-section{display:flex;flex-direction:column;gap:8px}
.dshc-cli-log{max-height:320px;margin:0;padding:12px;overflow:auto;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font:11px/17px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
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
.dshc-dock-row-hint{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshc-dock-toggle{display:inline-flex;align-items:center;justify-content:center;width:28px;height:16px;flex:none}
.dshc-dock-connect{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:24px;padding:0 4px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer}
.dshc-dock-connect:hover{color:var(--dsw-alias-label-primary)}
.dshc-dock-connect:disabled{opacity:.4;cursor:not-allowed}
.dshc-dock-pending{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:24px;padding:0 4px;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
.dshc-dock-pending-cancel{margin-left:2px;padding:0;border:0;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:12px;cursor:pointer;opacity:0;transition:opacity .12s}
.dshc-dock-row:hover .dshc-dock-pending-cancel,.dshc-dock-pending-cancel:focus-visible{opacity:1}
@media (hover:none){.dshc-dock-pending-cancel{opacity:1}}
.dshc-dock-tip{max-width:min(320px,calc(100vw - 32px))}
.dshc-dock-empty{padding:16px 8px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshc-dock-error{padding:4px 6px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dshc-dock-manage{display:flex;align-items:center;gap:6px;height:32px;margin-top:4px;padding:0 8px;border:0;border-top:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;flex:none}
.dshc-dock-manage:hover{color:var(--dsw-alias-label-primary)}
.dshc-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dshc-overlay-behind{background:transparent;backdrop-filter:none}
.dshc-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);max-height:min(800px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent)}
.dshc-dialog-detail,.dshc-dialog-wide{width:min(560px,100%)}
.dshc-dialog-credential{width:min(460px,100%)}
.dshc-dialog-instance{width:min(460px,100%)}
.dshc-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dshc-dialog-head-title{display:flex;align-items:center;gap:6px;min-width:0}
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
.dshc-dialog-status-pill{flex:none;max-width:240px;overflow:hidden;text-overflow:ellipsis}
.dshc-status-pill{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.dshc-status-pill-connected{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.dshc-status-pill-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.dshc-status-pill .dshc-spinner{margin-right:5px}
.dshc-field{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshc-meta-lang{display:flex;align-items:center;gap:10px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshc-lang-switch{display:inline-flex;gap:2px;padding:2px;border:.5px solid var(--dsw-alias-border-l);border-radius:var(--dsw-radius-md)}
.dshc-lang-option{border:0;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:18px;padding:2px 8px;border-radius:calc(var(--dsw-radius-md) - 2px);cursor:pointer}
.dshc-lang-option-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.dshc-field input{box-sizing:border-box;height:40px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dshc-field-control{position:relative;display:block}
.dshc-field-control input{width:100%;padding-right:40px}
.dshc-field-reveal{position:absolute;top:50%;right:6px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshc-field-reveal:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshc-field-reveal:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshc-field-copy{position:absolute;top:50%;right:6px;transform:translateY(-50%);height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;cursor:pointer}
.dshc-field-copy:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshc-field input::placeholder{color:var(--dsw-alias-label-caption)}
.dshc-field input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dshc-field select{box-sizing:border-box;width:100%;height:40px;padding:0 38px 0 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;appearance:none;cursor:pointer}
.dshc-field select:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dshc-field select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dshc-select-toggle-static{pointer-events:none}
.dshc-field textarea{box-sizing:border-box;min-height:180px;max-height:320px;padding:10px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:12px/18px var(--dsw-font-markdown-code-font-family);outline:none;resize:vertical}
.dshc-json-editor{position:relative;height:260px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);overflow:hidden;background:#fff}
.dshc-json-editor-mount{position:absolute;inset:0}
.dshc-json-editor-fallback{position:absolute;inset:0;box-sizing:border-box;width:100%;height:100%;padding:10px 14px;border:0;outline:0;resize:none;background:#fff;color:var(--dsw-alias-label-primary);font:12px/18px var(--dsw-font-markdown-code-font-family)}
.dshc-json-editor-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:6px;background:color-mix(in srgb,#fff 88%,transparent);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;pointer-events:none}
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
.dshc-dialog-alert{margin:0 24px;padding:8px 10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshc-tools{display:flex;flex-direction:column;gap:8px;min-height:0}
.dshc-tools-head{display:flex;align-items:center;gap:8px}
.dshc-tools-search-wrap{position:relative;display:inline-flex;align-items:center;margin-left:auto}
.dshc-tools-search{box-sizing:border-box;width:168px;height:28px;padding:0 28px 0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:26px;outline:none}
.dshc-tools-search-clear{position:absolute;top:50%;right:3px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dshc-tools-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshc-tools-search::placeholder{color:var(--dsw-alias-label-caption)}
.dshc-tools-search:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dshc-tools-empty{margin:0;padding:16px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshc-tools-head h3{margin:0;font-size:14px;font-weight:500;line-height:20px}
.dshc-tools-count{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:18px}
.dshc-capability-head{gap:6px}
.dshc-capability-head .dshc-tools-count{height:20px;padding:0 8px;font-size:11px;line-height:20px}
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
.dshc-tool-expand:disabled{opacity:.35;cursor:not-allowed}
.dshc-tool-expand:disabled:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}
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
