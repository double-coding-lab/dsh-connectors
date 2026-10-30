import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { loadBuiltinCatalog } from './catalog.js'
import type { CliConnectorService } from './cli/service.js'
import type { ConnectionService } from './connections.js'
import { ConnectError } from './errors.js'
import { ROUTE_PREFIX } from '../shared/types.js'
import type { CustomTranslations } from '../shared/types.js'

function parseCustomTranslationsInput(value: unknown): CustomTranslations | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConnectError('invalid_request', 'translations 必须是对象')
  }
  const out: CustomTranslations = {}
  for (const [locale, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConnectError('invalid_request', `translations.${locale} 必须是对象`)
    }
    const record = raw as Record<string, unknown>
    if (record.description !== undefined && typeof record.description !== 'string') {
      throw new ConnectError('invalid_request', `translations.${locale}.description 必须是字符串`)
    }
    if (record.category !== undefined && typeof record.category !== 'string') {
      throw new ConnectError('invalid_request', `translations.${locale}.category 必须是字符串`)
    }
    if (record.examples !== undefined && (!Array.isArray(record.examples) || record.examples.some(item => typeof item !== 'string'))) {
      throw new ConnectError('invalid_request', `translations.${locale}.examples 必须是字符串数组`)
    }
    out[locale] = {
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(typeof record.category === 'string' ? { category: record.category } : {}),
      ...(Array.isArray(record.examples) ? { examples: record.examples as string[] } : {}),
    }
  }
  return out
}

export interface RouterFace {  register: (options: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }) => () => void
}

export interface RouteOptions {
  version: string
  capabilities: () => Record<string, boolean>
  connections: ConnectionService
  cli: CliConnectorService
}

const MAX_BODY = 16 * 1024
const MONACO_URL_PREFIX = `${ROUTE_PREFIX}/api/monaco/`
const MONACO_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

let monacoRoot: string | null | undefined

function resolveMonacoRoot(): string | null {
  if (monacoRoot !== undefined) return monacoRoot
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('monaco-editor')
    monacoRoot = resolve(dirname(entry), '..')
  } catch {
    monacoRoot = null
  }
  return monacoRoot
}

async function serveMonaco(path: string, res: ServerResponse): Promise<void> {
  const root = resolveMonacoRoot()
  if (root === null) {
    res.writeHead(404)
    res.end('monaco-editor is not installed')
    return
  }
  let relative: string
  try {
    relative = decodeURIComponent(path.slice(MONACO_URL_PREFIX.length))
  } catch {
    res.writeHead(400)
    res.end('bad path')
    return
  }
  const normalized = normalize(relative)
  if (normalized === '' || normalized.startsWith('..') || isAbsolute(normalized)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const base = resolve(root)
  const file = resolve(base, normalized)
  if (file !== base && !file.startsWith(`${base}${sep}`)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': MONACO_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.byteLength,
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  })
  res.end(body)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    if (char === '&') return '&amp;'
    if (char === '<') return '&lt;'
    if (char === '>') return '&gt;'
    if (char === '"') return '&quot;'
    return '&#39;'
  })
}

function callbackPage(options: { ok: boolean; title: string; message: string }): string {
  const accent = options.ok ? '#1f8f4e' : '#c0392b'
  const glyph = options.ok ? '✓' : '!'
  const script = options.ok ? '<script>window.setTimeout(function(){window.close()},900)</script>' : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#f7f7f8;color:#1b1c1f;font:14px/22px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{box-sizing:border-box;width:min(360px,calc(100vw - 48px));padding:28px 24px;border-radius:20px;background:#fff;box-shadow:0 12px 40px rgba(20,22,28,.12);text-align:center}
.badge{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;margin-bottom:14px;border-radius:50%;background:${accent}1a;color:${accent};font-size:20px;font-weight:600}
h1{margin:0 0 8px;font-size:16px;font-weight:600;line-height:24px}
p{margin:0;color:#5c5f66;font-size:13px;line-height:20px;overflow-wrap:anywhere}
</style>
</head>
<body>
<main>
<div class="badge">${glyph}</div>
<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.message)}</p>
</main>
${script}
</body>
</html>`
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new ConnectError('payload_too_large', '请求体超过 16KB'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new ConnectError('invalid_json', '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function statusFor(error: ConnectError): number {
  if (error.code === 'not_found') return 404
  if (error.code === 'server_name_conflict') return 409
  if (error.code === 'cli_busy') return 409
  if (error.code === 'cli_not_installed') return 409
  if (error.code === 'loader_unavailable') return 503
  if (error.code === 'connect_failed') return 502
  if (error.code === 'cli_install_failed' || error.code === 'cli_login_failed' || error.code === 'cli_logout_failed' || error.code === 'cli_uninstall_failed') return 502
  if (error.code === 'cli_login_timeout') return 504
  if (error.code === 'cli_status_failed') return 502
  if (error.code === 'oauth_unreachable' || error.code === 'oauth_failed') return 502
  return 400
}

export function registerRoutes(ctx: Context, options: RouteOptions): () => void {
  const webServer = (ctx as Context & { webServer?: RouterFace }).webServer
  if (webServer === undefined) {
    console.warn('[dsh-connectors] webServer service is unavailable; panel API disabled')
    return () => {}
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname

    try {
      if (req.method === 'GET' && path.startsWith(MONACO_URL_PREFIX)) {
        await serveMonaco(path, res)
        return
      }

      if (req.method === 'GET' && path === `${ROUTE_PREFIX}/api/health`) {
        json(res, 200, {
          ok: true,
          value: {
            name: 'dsh-connectors',
            version: options.version,
            capabilities: options.capabilities(),
            node: process.versions.node,
          },
        })
        return
      }

      if (req.method === 'GET' && path === `${ROUTE_PREFIX}/api/catalog`) {
        try {
          const catalog = loadBuiltinCatalog()
          const cards = await options.connections.listCards()
          json(res, 200, { ok: true, value: { version: catalog.version, cards } })
        } catch (error) {
          json(res, 500, { ok: false, error: { code: 'catalog_load_failed', message: String(error) } })
        }
        return
      }

      if (req.method === 'GET' && path === `${ROUTE_PREFIX}/api/connections`) {
        json(res, 200, { ok: true, value: { connections: await options.connections.list() } })
        return
      }

      if (req.method === 'POST' && path === `${ROUTE_PREFIX}/api/connections`) {
        const body = await readJson(req) as { connectorId?: unknown; token?: unknown; instanceUrl?: unknown }
        if (typeof body.connectorId !== 'string' || body.connectorId === '') {
          throw new ConnectError('invalid_request', '缺少 connectorId')
        }
        const token = body.token
        if (token !== undefined && typeof token !== 'string') {
          throw new ConnectError('invalid_request', 'token 必须是字符串')
        }
        const instanceUrl = body.instanceUrl
        if (instanceUrl !== undefined && typeof instanceUrl !== 'string') {
          throw new ConnectError('invalid_request', 'instanceUrl 必须是字符串')
        }
        const connection = await options.connections.connect(body.connectorId, token, instanceUrl)
        json(res, 200, { ok: true, value: { connection } })
        return
      }

      if (req.method === 'POST' && path === `${ROUTE_PREFIX}/api/oauth/start`) {
        const body = await readJson(req) as { connectorId?: unknown; redirectUri?: unknown }
        if (typeof body.connectorId !== 'string' || body.connectorId === '') {
          throw new ConnectError('invalid_request', '缺少 connectorId')
        }
        if (typeof body.redirectUri !== 'string' || body.redirectUri === '') {
          throw new ConnectError('invalid_request', '缺少 redirectUri')
        }
        const value = await options.connections.startOAuth(body.connectorId, body.redirectUri)
        json(res, 200, { ok: true, value })
        return
      }

      const oauthClientId = req.method === 'POST'
        ? new RegExp(`^${ROUTE_PREFIX}/api/connections/([^/]+)/oauth-client$`).exec(path)?.[1]
        : undefined
      if (oauthClientId !== undefined) {
        const body = await readJson(req) as { clientId?: unknown; clientSecret?: unknown }
        if (typeof body.clientId !== 'string' || body.clientId.trim() === '') {
          throw new ConnectError('invalid_request', '缺少 AppKey')
        }
        if (typeof body.clientSecret !== 'string' || body.clientSecret.trim() === '') {
          throw new ConnectError('invalid_request', '缺少 SecretKey')
        }
        const connection = await options.connections.saveOAuthClient(
          decodeURIComponent(oauthClientId),
          body.clientId.trim(),
          body.clientSecret.trim(),
        )
        json(res, 200, { ok: true, value: { connection } })
        return
      }

      if (req.method === 'POST' && path === `${ROUTE_PREFIX}/api/oauth/cancel`) {
        const body = await readJson(req) as { flowId?: unknown }
        if (typeof body.flowId !== 'string' || body.flowId === '') {
          throw new ConnectError('invalid_request', '缺少 flowId')
        }
        options.connections.cancelOAuth(body.flowId)
        json(res, 200, { ok: true, value: {} })
        return
      }

      if (req.method === 'GET' && path === `${ROUTE_PREFIX}/api/oauth/status`) {
        const flowId = url.searchParams.get('flowId')
        if (flowId === null || flowId === '') {
          throw new ConnectError('invalid_request', '缺少 flowId')
        }
        json(res, 200, { ok: true, value: options.connections.oauthFlowStatus(flowId) })
        return
      }

      if (req.method === 'GET' && path === `${ROUTE_PREFIX}/api/oauth/callback`) {
        const providerError = url.searchParams.get('error')
        const state = url.searchParams.get('state') ?? ''
        if (providerError !== null) {
          const message = url.searchParams.get('error_description') ?? providerError
          if (state !== '') options.connections.failOAuthFlow(state, message)
          html(res, 400, callbackPage({
            ok: false,
            title: '授权未完成',
            message,
          }))
          return
        }
        const code = url.searchParams.get('code')
        if (code === null || code === '' || state === '') {
          const message = '缺少授权码或状态参数，请回到连接器面板重试。'
          if (state !== '') options.connections.failOAuthFlow(state, message)
          html(res, 400, callbackPage({
            ok: false,
            title: '授权未完成',
            message,
          }))
          return
        }
        try {
          const connection = await options.connections.completeOAuth(state, code)
          html(res, 200, callbackPage({
            ok: true,
            title: '授权完成',
            message: `${connection.name} 已连接，可以关闭此标签页。`,
          }))
        } catch (error) {
          const message = error instanceof ConnectError ? error.message : String(error)
          console.warn('[dsh-connectors] OAuth callback failed', message)
          html(res, 400, callbackPage({ ok: false, title: '授权未完成', message }))
        }
        return
      }

      if (req.method === 'POST' && path === `${ROUTE_PREFIX}/api/custom-connectors`) {
        const body = await readJson(req) as {
          json?: unknown
          allowPrivate?: unknown
          category?: unknown
          description?: unknown
          examples?: unknown
          translations?: unknown
        }
        if (typeof body.json !== 'string' || body.json.trim() === '') {
          throw new ConnectError('invalid_request', '缺少 mcpServers JSON')
        }
        if (body.allowPrivate !== undefined && typeof body.allowPrivate !== 'boolean') {
          throw new ConnectError('invalid_request', 'allowPrivate 必须是布尔值')
        }
        if (body.category !== undefined && typeof body.category !== 'string') {
          throw new ConnectError('invalid_request', 'category 必须是字符串')
        }
        if (body.description !== undefined && typeof body.description !== 'string') {
          throw new ConnectError('invalid_request', 'description 必须是字符串')
        }
        if (body.examples !== undefined && (!Array.isArray(body.examples) || body.examples.some(item => typeof item !== 'string'))) {
          throw new ConnectError('invalid_request', 'examples 必须是字符串数组')
        }
        const translations = parseCustomTranslationsInput(body.translations)
        const connectors = await options.connections.importCustom(body.json, body.allowPrivate === true, {
          ...(body.category === undefined ? {} : { category: body.category }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.examples === undefined ? {} : { examples: body.examples as string[] }),
          ...(translations === undefined ? {} : { translations }),
        })
        json(res, 200, { ok: true, value: { connectors } })
        return
      }

      const customConfigId = req.method === 'GET'
        ? new RegExp(`^${ROUTE_PREFIX}/api/custom-connectors/([^/]+)/config$`).exec(path)?.[1]
        : undefined
      if (customConfigId !== undefined) {
        const config = await options.connections.customConfig(decodeURIComponent(customConfigId))
        json(res, 200, { ok: true, value: { config } })
        return
      }

      const updateCustomId = req.method === 'PUT'
        ? new RegExp(`^${ROUTE_PREFIX}/api/custom-connectors/([^/]+)$`).exec(path)?.[1]
        : undefined
      if (updateCustomId !== undefined) {
        const body = await readJson(req) as {
          json?: unknown
          allowPrivate?: unknown
          category?: unknown
          description?: unknown
          examples?: unknown
          translations?: unknown
        }
        if (typeof body.json !== 'string' || body.json.trim() === '') {
          throw new ConnectError('invalid_request', '缺少 mcpServers JSON')
        }
        if (body.allowPrivate !== undefined && typeof body.allowPrivate !== 'boolean') {
          throw new ConnectError('invalid_request', 'allowPrivate 必须是布尔值')
        }
        if (body.category !== undefined && typeof body.category !== 'string') {
          throw new ConnectError('invalid_request', 'category 必须是字符串')
        }
        if (body.description !== undefined && typeof body.description !== 'string') {
          throw new ConnectError('invalid_request', 'description 必须是字符串')
        }
        if (body.examples !== undefined && (!Array.isArray(body.examples) || body.examples.some(item => typeof item !== 'string'))) {
          throw new ConnectError('invalid_request', 'examples 必须是字符串数组')
        }
        const translations = parseCustomTranslationsInput(body.translations)
        const result = await options.connections.updateCustom(
          decodeURIComponent(updateCustomId),
          body.json,
          body.allowPrivate === true,
          {
            ...(body.category === undefined ? {} : { category: body.category }),
            ...(body.description === undefined ? {} : { description: body.description }),
            ...(body.examples === undefined ? {} : { examples: body.examples as string[] }),
            ...(translations === undefined ? {} : { translations }),
          },
        )
        json(res, 200, { ok: true, value: result })
        return
      }

      const customId = req.method === 'DELETE'
        ? new RegExp(`^${ROUTE_PREFIX}/api/custom-connectors/([^/]+)$`).exec(path)?.[1]
        : undefined
      if (customId !== undefined) {
        await options.connections.removeCustom(decodeURIComponent(customId))
        json(res, 200, { ok: true, value: {} })
        return
      }

      const patchId = req.method === 'PATCH'
        ? new RegExp(`^${ROUTE_PREFIX}/api/connections/([^/]+)$`).exec(path)?.[1]
        : undefined
      if (patchId !== undefined) {
        const body = await readJson(req) as { enabled?: unknown }
        if (typeof body.enabled !== 'boolean') {
          throw new ConnectError('invalid_request', 'enabled 必须是布尔值')
        }
        const connection = await options.connections.setEnabled(decodeURIComponent(patchId), body.enabled)
        json(res, 200, { ok: true, value: { connection } })
        return
      }

      const instanceId = req.method === 'POST'
        ? new RegExp(`^${ROUTE_PREFIX}/api/connections/([^/]+)/instance$`).exec(path)?.[1]
        : undefined
      if (instanceId !== undefined) {
        const body = await readJson(req) as { instanceUrl?: unknown }
        if (typeof body.instanceUrl !== 'string' || body.instanceUrl.trim() === '') {
          throw new ConnectError('invalid_request', '缺少 instanceUrl')
        }
        const connection = await options.connections.reconfigureInstance(
          decodeURIComponent(instanceId),
          body.instanceUrl,
        )
        json(res, 200, { ok: true, value: { connection } })
        return
      }

      const revokeId = req.method === 'DELETE'
        ? new RegExp(`^${ROUTE_PREFIX}/api/connections/([^/]+)/oauth$`).exec(path)?.[1]
        : undefined
      if (revokeId !== undefined) {
        const connection = await options.connections.revokeOAuth(decodeURIComponent(revokeId))
        json(res, 200, { ok: true, value: { connection } })
        return
      }

      const connectorId = req.method === 'DELETE'
        ? new RegExp(`^${ROUTE_PREFIX}/api/connections/([^/]+)$`).exec(path)?.[1]
        : undefined
      if (connectorId !== undefined) {
        await options.connections.disconnect(decodeURIComponent(connectorId))
        json(res, 200, { ok: true, value: {} })
        return
      }

      if (req.method === 'GET' && path === `${ROUTE_PREFIX}/api/cli`) {
        json(res, 200, { ok: true, value: { connectors: await options.cli.list() } })
        return
      }

      const cliPatchId = req.method === 'PATCH'
        ? new RegExp(`^${ROUTE_PREFIX}/api/cli/([^/]+)$`).exec(path)?.[1]
        : undefined
      if (cliPatchId !== undefined) {
        const body = await readJson(req) as { enabled?: unknown }
        if (typeof body.enabled !== 'boolean') {
          throw new ConnectError('invalid_request', '缺少 enabled 参数')
        }
        const id = decodeURIComponent(cliPatchId)
        json(res, 200, { ok: true, value: { connector: await options.cli.setEnabled(id, body.enabled) } })
        return
      }

      const cliAction = req.method === 'POST'
        ? new RegExp(`^${ROUTE_PREFIX}/api/cli/([^/]+)/(install|update|login|logout|cancel|uninstall)$`).exec(path)
        : undefined
      if (cliAction !== null && cliAction !== undefined) {
        const rawId = cliAction[1]
        const action = cliAction[2]
        if (rawId === undefined || action === undefined) {
          throw new ConnectError('invalid_request', '缺少 CLI 连接器参数')
        }
        const id = decodeURIComponent(rawId)
        if (action === 'install') {
          json(res, 200, { ok: true, value: { connector: await options.cli.startInstall(id) } })
          return
        }
        if (action === 'update') {
          json(res, 200, { ok: true, value: { connector: await options.cli.startUpdate(id) } })
          return
        }
        if (action === 'login') {
          json(res, 200, { ok: true, value: { connector: await options.cli.startLogin(id) } })
          return
        }
        if (action === 'logout') {
          json(res, 200, { ok: true, value: { connector: await options.cli.logout(id) } })
          return
        }
        if (action === 'uninstall') {
          json(res, 200, { ok: true, value: { connector: await options.cli.startUninstall(id) } })
          return
        }
        json(res, 200, { ok: true, value: { connector: await options.cli.cancel(id) } })
        return
      }

      const cliLogId = req.method === 'GET'
        ? new RegExp(`^${ROUTE_PREFIX}/api/cli/([^/]+)/log$`).exec(path)?.[1]
        : undefined
      if (cliLogId !== undefined) {
        json(res, 200, { ok: true, value: { output: options.cli.log(decodeURIComponent(cliLogId)) } })
        return
      }

      const cliId = req.method === 'GET'
        ? new RegExp(`^${ROUTE_PREFIX}/api/cli/([^/]+)$`).exec(path)?.[1]
        : undefined
      if (cliId !== undefined) {
        const id = decodeURIComponent(cliId)
        json(res, 200, { ok: true, value: { connector: await options.cli.refresh(id) } })
        return
      }

      json(res, 404, { ok: false, error: { code: 'not_found', message: path } })
    } catch (error) {
      if (error instanceof ConnectError) {
        json(res, statusFor(error), { ok: false, error: { code: error.code, message: error.message } })
        return
      }
      json(res, 500, { ok: false, error: { code: 'internal_error', message: String(error) } })
    }
  }

  return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
