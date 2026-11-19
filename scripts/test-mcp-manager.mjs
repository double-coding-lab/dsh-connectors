import assert from 'node:assert/strict'

import { ConnectionService } from '../dist/host/connections.js'

function makeHarness() {
  const tables = new Map()
  const tableFor = name => {
    if (!tables.has(name)) {
      const rows = new Map()
      tables.set(name, {
        get: key => rows.get(key),
        entries: () => rows.entries(),
        put: async (key, value) => {
          rows.set(key, value)
        },
        delete: async key => {
          rows.delete(key)
        },
      })
    }
    return tables.get(name)
  }

  const loaderEntries = new Map()
  const loaderCalls = []
  const loader = {
    resolve: id => (loaderEntries.has(id) ? { options: { config: loaderEntries.get(id) } } : undefined),
    create: async ({ id, config }) => {
      loaderCalls.push(['create', id])
      loaderEntries.set(id, config)
    },
    update: async (id, { config }) => {
      loaderCalls.push(['update', id])
      loaderEntries.set(id, config)
    },
    remove: async id => {
      loaderCalls.push(['remove', id])
      loaderEntries.delete(id)
    },
  }

  const managed = new Map()
  const registerCalls = []
  let statusFor = () => ({ state: 'connected', toolCount: 1, connectedAt: 1 })
  const manager = {
    register(name, entry) {
      if (managed.has(name)) throw new Error(`mcp-manager: server "${name}" is already configured or registered`)
      registerCalls.push({ name, entry })
      managed.set(name, statusFor(name, entry))
      return () => {
        managed.delete(name)
      }
    },
    list: () => [...managed].map(([name, status]) => ({ name, configured: true, status })),
  }

  const tools = {
    schemas: () => [
      ...[...managed].filter(([, status]) => status.state === 'connected').map(([name]) => name),
      ...[...loaderEntries.values()].map(config => config.serverName),
    ].map(name => ({ name: `mcp__${name}__echo`, description: 'echo' })),
  }

  const service = new ConnectionService({
    loader,
    tools,
    storageDomain: { open: async () => ({ table: tableFor, close: async () => {} }) },
  }, () => [])

  return {
    service,
    manager,
    managed,
    registerCalls,
    loaderCalls,
    loaderEntries,
    connections: tableFor('connections'),
    setStatus: fn => {
      statusFor = fn
    },
  }
}

async function importOne(service, name, config) {
  const [card] = await service.importCustom(JSON.stringify({ mcpServers: { [name]: config } }), true, {})
  return card.id
}

// 有 mcpManager 时走注册，条目只带传输字段和启动预算
{
  const h = makeHarness()
  await h.service.attachManager(h.manager)
  const id = await importOne(h.service, 'local-echo', { command: 'node', args: ['echo.js'], env: { MODE: 'x' } })
  const view = await h.service.connect(id)
  assert.equal(view.tools.length, 1)
  assert.deepEqual(h.registerCalls, [{
    name: 'local-echo',
    entry: { transport: 'stdio', command: 'node', args: ['echo.js'], env: { MODE: 'x' }, startupTimeoutMs: 120_000 },
  }])
  assert.deepEqual(h.loaderCalls, [])

  await h.service.setEnabled(id, false)
  assert.equal(h.managed.size, 0)
  await h.service.setEnabled(id, true)
  assert.equal(h.managed.size, 1)

  await h.service.disconnect(id)
  assert.equal(h.managed.size, 0)
  assert.deepEqual(h.loaderCalls, [])
}

// HTTP 条目带请求头，SSE 条目经本地桥接转成 stdio
{
  const h = makeHarness()
  await h.service.attachManager(h.manager)
  const httpId = await importOne(h.service, 'remote-http', {
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer secret-token' },
  })
  await h.service.connect(httpId)
  assert.deepEqual(h.registerCalls[0], {
    name: 'remote-http',
    entry: {
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret-token' },
      startupTimeoutMs: 30_000,
    },
  })

  const sseId = await importOne(h.service, 'remote-sse', { type: 'sse', url: 'https://example.com/sse' })
  await h.service.connect(sseId)
  const sse = h.registerCalls[1].entry
  assert.equal(sse.transport, 'stdio')
  assert.equal(sse.command, process.execPath)
  assert.equal(sse.env.DSH_SSE_URL, 'https://example.com/sse')
  assert.equal(sse.url, undefined)
  assert.equal(sse.startupTimeoutMs, 30_000)
}

// 含 ${…} 字面量的条目不交给管理器，避免被当成凭据模板
{
  const h = makeHarness()
  await h.service.attachManager(h.manager)
  const id = await importOne(h.service, 'tpl-echo', { command: 'node', args: ['echo.js', '${HOME}'] })
  const view = await h.service.connect(id)
  assert.equal(view.tools.length, 1)
  assert.equal(h.registerCalls.length, 0)
  assert.deepEqual(h.loaderCalls, [['create', 'dsh-connectors-custom-tpl-echo']])
  await h.service.disconnect(id)
  assert.equal(h.loaderEntries.size, 0)
}

// 启动失败时立即报出原因并撤回注册，密钥不出现在错误里
{
  const h = makeHarness()
  await h.service.attachManager(h.manager)
  h.setStatus(() => ({
    state: 'reconnecting',
    attempt: 1,
    maxAttempts: 10,
    nextRetryAtMs: 0,
    lastError: 'startup: 401 for Bearer secret-token',
  }))
  const id = await importOne(h.service, 'broken-http', {
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer secret-token' },
  })
  await assert.rejects(
    () => h.service.connect(id),
    error => error?.code === 'connect_failed'
      && error.message.includes('startup: 401')
      && !error.message.includes('secret-token'),
  )
  assert.equal(h.managed.size, 0)
  assert.equal(h.connections.get(id), undefined)
}

// 同名服务已被设置或其他插件占用时给出可操作的提示
{
  const h = makeHarness()
  await h.service.attachManager(h.manager)
  h.manager.register('taken', { transport: 'stdio', command: 'other' })
  const id = await importOne(h.service, 'taken', { command: 'node', args: ['echo.js'] })
  await assert.rejects(
    () => h.service.connect(id),
    error => error?.code === 'connect_failed' && error.message.includes('已有同名 MCP 服务 "taken"'),
  )
  assert.equal(h.managed.size, 1)
}

// 已连接的服务之后耗尽重连次数，列表上显示失败原因
{
  const h = makeHarness()
  await h.service.attachManager(h.manager)
  const id = await importOne(h.service, 'flaky', { command: 'node', args: ['echo.js'] })
  await h.service.connect(id)
  assert.equal((await h.service.list())[0].error, undefined)
  h.managed.set('flaky', { state: 'failed', reason: 'gave-up', lastError: 'Connection closed' })
  const [view] = await h.service.list()
  assert.equal(view.error, 'Connection closed')
  assert.equal(view.tools.length, 0)
}

// 宿主没有 mcpManager 时等待结束后用 loader 恢复；之后管理器出现则迁移过去
{
  const h = makeHarness()
  const id = await importOne(h.service, 'restored', { command: 'node', args: ['echo.js'] })
  await h.service.connect(id)
  assert.deepEqual(h.loaderCalls, [['create', 'dsh-connectors-custom-restored']])

  h.loaderCalls.length = 0
  await h.service.start(30)
  assert.deepEqual(h.loaderCalls, [['update', 'dsh-connectors-custom-restored']])

  h.loaderCalls.length = 0
  await h.service.attachManager(h.manager)
  assert.deepEqual(h.loaderCalls, [['remove', 'dsh-connectors-custom-restored']])
  assert.deepEqual(h.registerCalls.map(call => call.name), ['restored'])

  await h.service.restore()
  assert.equal(h.registerCalls.length, 1)

  h.service.detachManager()
  await h.service.restore()
  assert.deepEqual(h.loaderCalls.at(-1), ['create', 'dsh-connectors-custom-restored'])
}

// 管理器在等待期内就绪时，start 不再走 loader
{
  const h = makeHarness()
  const id = await importOne(h.service, 'early', { command: 'node', args: ['echo.js'] })
  await h.service.connect(id)
  h.loaderCalls.length = 0
  const started = h.service.start(2000)
  await h.service.attachManager(h.manager)
  await started
  assert.deepEqual(h.loaderCalls, [['remove', 'dsh-connectors-custom-early']])
  assert.equal(h.managed.size, 1)
}

console.log('mcp manager tests passed')
