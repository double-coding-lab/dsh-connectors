import process from 'node:process'

import { Client, SSEClientTransport } from '@modelcontextprotocol/client'

const BRIDGE_NAME = 'dsh-sse-bridge'
const BRIDGE_VERSION = '0.1.0'
const FALLBACK_PROTOCOL_VERSION = '2025-06-18'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

function fail(message: string): never {
  process.stderr.write(`[dsh-sse-bridge] ${message}\n`)
  process.exit(1)
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail('DSH_SSE_HEADERS 必须是 JSON 对象')
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') fail(`DSH_SSE_HEADERS.${key} 必须是字符串`)
      headers[key] = value
    }
    return headers
  } catch (error) {
    fail(`DSH_SSE_HEADERS 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

const url = process.env.DSH_SSE_URL
if (url === undefined || url.trim() === '') fail('缺少 DSH_SSE_URL')
const headers = parseHeaders(process.env.DSH_SSE_HEADERS)

const client = new Client({ name: BRIDGE_NAME, version: BRIDGE_VERSION })
const transport = new SSEClientTransport(new URL(url), {
  requestInit: { headers },
})

let protocolVersion = FALLBACK_PROTOCOL_VERSION

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : -32603
}

async function dispatch(request: JsonRpcRequest): Promise<void> {
  try {
    switch (request.method) {
      case 'initialize': {
        const requested = request.params?.protocolVersion
        if (typeof requested === 'string' && requested !== '') protocolVersion = requested
        write({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
          },
        })
        return
      }
      case 'ping':
        write({ jsonrpc: '2.0', id: request.id, result: {} })
        return
      case 'tools/list': {
        const cursor = request.params?.cursor
        const result = await client.listTools(typeof cursor === 'string' ? { cursor } : undefined)
        write({ jsonrpc: '2.0', id: request.id, result })
        return
      }
      case 'tools/call': {
        const name = request.params?.name
        if (typeof name !== 'string' || name === '') {
          write({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'tools/call 缺少工具名' } })
          return
        }
        const args = request.params?.arguments
        const result = await client.callTool({
          name,
          arguments: typeof args === 'object' && args !== null && !Array.isArray(args)
            ? args as Record<string, unknown>
            : {},
        })
        write({ jsonrpc: '2.0', id: request.id, result })
        return
      }
      case 'logging/setLevel':
        write({ jsonrpc: '2.0', id: request.id, result: {} })
        return
      default:
        write({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `SSE 桥不支持方法 ${request.method}` },
        })
    }
  } catch (error) {
    write({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: errorCode(error), message: errorMessage(error) },
    })
  }
}

function handleLine(line: string): void {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message: unknown
  try {
    message = JSON.parse(trimmed)
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无法解析 JSON-RPC 消息' } })
    return
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return
  const record = message as Record<string, unknown>
  if (record.id === undefined || record.id === null) return
  if (typeof record.method !== 'string') return
  void dispatch({
    jsonrpc: '2.0',
    id: record.id as string | number,
    method: record.method,
    ...(typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params)
      ? { params: record.params as Record<string, unknown> }
      : {}),
  })
}

client.onerror = error => {
  process.stderr.write(`[dsh-sse-bridge] 上游连接错误：${errorMessage(error)}\n`)
  process.exit(1)
}
transport.onclose = () => {
  process.stderr.write('[dsh-sse-bridge] 上游 SSE 连接已关闭\n')
  process.exit(1)
}

try {
  await client.connect(transport)
} catch (error) {
  fail(`连接 SSE 服务失败：${errorMessage(error)}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    handleLine(line)
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => {
  void client.close().finally(() => process.exit(0))
})
