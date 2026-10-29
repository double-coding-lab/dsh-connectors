import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bridge = join(root, 'dist', 'host', 'sse-bridge.js')
const token = 'test-token'

let stream = null
let endpoint = ''
let authHeader = ''

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'GET' && url.pathname === '/sse') {
    authHeader = req.headers.authorization ?? ''
    if (authHeader !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write('event: endpoint\ndata: /messages?session=abc\n\n')
    stream = res
    return
  }
  if (req.method === 'POST' && url.pathname === '/messages') {
    let body = ''
    for await (const chunk of req) body += chunk
    res.writeHead(202, { 'Content-Type': 'text/plain' })
    res.end('accepted')
    const message = JSON.parse(body)
    if (message.id === undefined) return
    let result
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-sse', version: '1.0.0' },
      }
    } else if (message.method === 'tools/list') {
      result = {
        tools: [{
          name: 'echo',
          description: 'Echo the given text',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        }],
      }
    } else if (message.method === 'tools/call') {
      result = {
        content: [{ type: 'text', text: `echo:${message.params?.arguments?.text ?? ''}` }],
      }
    } else {
      stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported' } })}\n\n`)
      return
    }
    stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
endpoint = `http://127.0.0.1:${address.port}/sse`

function startBridge(headers) {
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      DSH_SSE_URL: endpoint,
      DSH_SSE_HEADERS: JSON.stringify(headers),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const responses = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') {
        const message = JSON.parse(line)
        if (message.id !== undefined) responses.set(message.id, message)
      }
      index = buffer.indexOf('\n')
    }
  })
  return { child, responses }
}

const waitFor = async (responses, id, timeoutMs = 8000) => {
  const started = Date.now()
  while (!responses.has(id)) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待响应 ${id} 超时`)
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  return responses.get(id)
}

const { child, responses } = startBridge({ Authorization: `Bearer ${token}` })
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`)
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })}\n`)

const initialized = await waitFor(responses, 1)
assert.equal(initialized.result.serverInfo.name, 'dsh-sse-bridge')
const listed = await waitFor(responses, 2)
assert.equal(listed.result.tools.length, 1)
assert.equal(listed.result.tools[0].name, 'echo')
const called = await waitFor(responses, 3)
assert.equal(called.result.content[0].text, 'echo:hi')
assert.equal(authHeader, `Bearer ${token}`)
child.stdin.end()
await once(child, 'exit')
stream?.end()

const rejected = startBridge({ Authorization: 'Bearer wrong-token' })
const [code] = await once(rejected.child, 'exit')
assert.notEqual(code, 0, '错误令牌时桥应启动失败')

server.close()
console.log('sse bridge tests: passed')
