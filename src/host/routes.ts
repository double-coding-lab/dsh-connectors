import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'

import { loadBuiltinCatalog } from './catalog.js'
import type { ConnectionService } from './connections.js'
import { ConnectError } from './errors.js'
import { ROUTE_PREFIX } from '../shared/types.js'

export interface RouterFace {
  register: (options: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }) => () => void
}

export interface RouteOptions {
  version: string
  capabilities: () => Record<string, boolean>
  connections: ConnectionService
}

const MAX_BODY = 16 * 1024

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
  if (error.code === 'loader_unavailable') return 503
  if (error.code === 'connect_failed') return 502
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
        const connectors = await options.connections.importCustom(body.json, body.allowPrivate === true, {
          ...(body.category === undefined ? {} : { category: body.category }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.examples === undefined ? {} : { examples: body.examples as string[] }),
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
        const result = await options.connections.updateCustom(
          decodeURIComponent(updateCustomId),
          body.json,
          body.allowPrivate === true,
          {
            ...(body.category === undefined ? {} : { category: body.category }),
            ...(body.description === undefined ? {} : { description: body.description }),
            ...(body.examples === undefined ? {} : { examples: body.examples as string[] }),
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
