import assert from 'node:assert/strict'

import { ConnectionService } from '../dist/host/connections.js'

process.env.DSH_CONNECTORS_NO_BROWSER = '1'

function makeTables() {
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
  return tableFor
}

const oauthCard = {
  id: 'linear',
  name: 'Linear',
  category: '开发工具',
  summary: '',
  published: true,
  auth: { type: 'oauth2', flow: 'pkce', registration: 'dcr', scopes: ['read', 'write'] },
  server: { serverName: 'linear', transport: 'streamable-http', url: 'https://mcp.linear.app/mcp' },
}

const noneCard = {
  id: 'ctx',
  name: 'Ctx',
  category: '开发工具',
  summary: '',
  published: true,
  auth: { type: 'none' },
  server: { serverName: 'ctx', transport: 'streamable-http', url: 'https://example.com/mcp' },
}

function makeHarness({ alpha }) {
  const tableFor = makeTables()
  const managed = new Map()
  const calls = []
  const manager = {
    register(name, entry) {
      if (managed.has(name)) {
        throw new Error(`mcp-manager: server "${name}" is already configured or registered`)
      }
      calls.push(['register', name, entry])
      managed.set(name, {
        entry,
        status: entry.oauth === undefined
          ? { state: 'connected', toolCount: 1, connectedAt: 1 }
          : { state: 'waiting-authorization', reason: 'missing', lastError: '' },
        authorization: undefined,
      })
      return () => managed.delete(name)
    },
    list: () => [...managed].map(([name, value]) => ({
      name,
      configured: true,
      status: value.status,
      ...(value.authorization === undefined ? {} : { authorization: value.authorization }),
    })),
  }
  if (alpha) {
    manager.startAuthorization = async name => {
      calls.push(['startAuthorization', name])
      const value = managed.get(name)
      value.authorization = { id: 'attempt-1', phase: 'waiting-browser', authorizationUrl: 'https://auth.example/authorize' }
      return value.authorization
    }
    manager.cancelAuthorization = async (name, id) => {
      calls.push(['cancelAuthorization', name, id])
      const value = managed.get(name)
      if (value?.authorization?.id === id) value.authorization = { ...value.authorization, phase: 'cancelled' }
    }
    manager.signOut = async name => {
      calls.push(['signOut', name])
      const value = managed.get(name)
      value.authorization = undefined
      value.status = { state: 'waiting-authorization', reason: 'missing', lastError: '' }
    }
  }
  const service = new ConnectionService({
    loader: { resolve: () => undefined, create: async () => {}, update: async () => {}, remove: async () => {} },
    // 按需加载的 server 只注册 load_tools，其余注册普通工具
    tools: {
      schemas: () => [...managed].flatMap(([name, value]) => (value.entry.toolLoading === 'on-demand'
        ? [{ name: `mcp__${name}__load_tools`, description: 'load' }]
        : [{ name: `mcp__${name}__echo`, description: 'echo' }])),
    },
    storageDomain: { open: async () => ({ table: tableFor, close: async () => {} }) },
  }, () => [oauthCard, noneCard])
  return { service, manager, managed, calls, connections: tableFor('connections') }
}

// 旧宿主（rc.5）：没有 startAuthorization，能力为 false，条目不带 oauth / toolLoading
{
  const h = makeHarness({ alpha: false })
  await h.service.attachManager(h.manager)
  assert.deepEqual(h.service.features(), { managerOAuth: false, toolLoading: false })
  const view = await h.service.connect('linear')
  assert.equal(view.authorized, false)
  assert.equal(h.calls.length, 0)
}

// alpha 宿主：新装 OAuth 连接默认 on-demand，条目带 oauth.credentialKey，等待授权不算启动失败
{
  const h = makeHarness({ alpha: true })
  await h.service.attachManager(h.manager)
  assert.deepEqual(h.service.features(), { managerOAuth: true, toolLoading: true })
  const view = await h.service.connect('linear')
  assert.equal(view.authorized, false)
  assert.equal(view.toolLoading, 'on-demand')
  assert.deepEqual(h.calls, [['register', 'linear', {
    transport: 'streamable-http',
    url: 'https://mcp.linear.app/mcp',
    headers: {},
    startupTimeoutMs: 30_000,
    toolLoading: 'on-demand',
    oauth: { credentialKey: 'mcp-client/linear', scope: 'read write' },
  }]])

  const started = await h.service.startOAuth('linear', 'http://127.0.0.1:3080/dsh-connectors/api/oauth/callback')
  assert.equal(started.authorizeUrl, 'https://auth.example/authorize')
  assert.equal(started.opened, false)
  assert.deepEqual(h.service.oauthFlowStatus(started.flowId), { status: 'pending' })

  h.managed.get('linear').authorization = { id: 'attempt-1', phase: 'authorized' }
  h.managed.get('linear').status = { state: 'connected', toolCount: 1, connectedAt: 2 }
  assert.deepEqual(h.service.oauthFlowStatus(started.flowId), { status: 'done' })
  const [authorized] = await h.service.list()
  assert.equal(authorized.authorized, true)

  h.managed.get('linear').authorization = { id: 'attempt-1', phase: 'failed', lastError: 'denied' }
  assert.equal(h.service.oauthFlowStatus(started.flowId).status, 'error')
}

// 取消授权、退出登录与卸载都会走管理器
{
  const h = makeHarness({ alpha: true })
  await h.service.attachManager(h.manager)
  await h.service.connect('linear')
  const started = await h.service.startOAuth('linear', 'http://127.0.0.1:3080/dsh-connectors/api/oauth/callback')
  await h.service.cancelOAuth(started.flowId)
  assert.deepEqual(h.calls.at(-1), ['cancelAuthorization', 'linear', 'attempt-1'])

  h.managed.get('linear').authorization = { id: 'attempt-2', phase: 'authorized' }
  h.managed.get('linear').status = { state: 'connected', toolCount: 1, connectedAt: 2 }
  const revoked = await h.service.revokeOAuth('linear')
  assert.equal(revoked.authorized, false)
  assert.deepEqual(h.calls.at(-1), ['signOut', 'linear'])

  h.managed.get('linear').authorization = { id: 'attempt-3', phase: 'authorized' }
  await h.service.disconnect('linear')
  assert.deepEqual(h.calls.at(-1), ['signOut', 'linear'])
  assert.equal(h.connections.get('linear'), undefined)
}

// 管理器宿主统一按需加载：新装与升级前的旧记录都注册为 on-demand
{
  const h = makeHarness({ alpha: true })
  await h.service.attachManager(h.manager)
  const view = await h.service.connect('ctx')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][2].toolLoading, 'on-demand')
  assert.equal(view.toolLoading, 'on-demand')
  assert.deepEqual(view.tools, ['mcp__ctx__load_tools'])

  h.connections.put('linear', {
    key: 'linear',
    connectorId: 'linear',
    name: 'Linear',
    serverName: 'linear',
    transport: 'streamable-http',
    url: 'https://mcp.linear.app/mcp',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  })
  h.managed.clear()
  h.calls.length = 0
  await h.service.restore()
  assert.equal(h.calls[0][2].toolLoading, 'on-demand')
}

// 同名服务被官方插件占用时提示去官方插件页
{
  const h = makeHarness({ alpha: true })
  await h.service.attachManager(h.manager)
  h.manager.register('linear', { transport: 'streamable-http', url: 'https://mcp.linear.app/mcp' })
  await assert.rejects(
    () => h.service.connect('linear'),
    error => error?.code === 'connect_failed' && error.message.includes('官方 Linear 插件'),
  )
}

console.log('alpha feature tests passed')
