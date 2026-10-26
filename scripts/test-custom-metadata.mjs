import assert from 'node:assert/strict'

import { canonicalizeCardCategories, parseExampleLines, resolveCategory, validateCategory } from '../dist/shared/categories.js'
import { parseMcpServers } from '../dist/host/mcpServers.js'
import { ConnectionService } from '../dist/host/connections.js'
import { CUSTOM_SECRET_PLACEHOLDER } from '../dist/shared/customConfig.js'

assert.equal(resolveCategory(' 开发工具 '), '开发工具')
assert.equal(resolveCategory('  '), '其他')
assert.equal(resolveCategory('DevOps'), 'DevOps')
assert.equal(validateCategory('全部'), '「全部」是保留名称，请换一个类别')
assert.equal(validateCategory('自定义'), '「自定义」是保留名称，请换一个类别')
assert.equal(validateCategory(''), '类别不能为空')
assert.ok(validateCategory('这是一个超过十六个字符的自定义类别名称') !== undefined)

const merged = canonicalizeCardCategories([
  { category: '开发工具', id: 'a' },
  { category: ' 开发工具 ', id: 'b' },
  { category: 'DevOps', id: 'c' },
  { category: 'devops', id: 'd' },
  { category: '设计协作', id: 'e' },
])
assert.deepEqual(merged.map(card => card.category), ['开发工具', '开发工具', 'DevOps', 'DevOps', '设计协作'])

assert.deepEqual(parseExampleLines('  one  \n\n two \n'), ['one', 'two'])

const [httpSeed] = parseMcpServers(JSON.stringify({
  mcpServers: {
    deepwiki: {
      url: 'https://mcp.deepwiki.com/mcp',
      'x-dsh': {
        category: '知识检索',
        description: '查询 GitHub 仓库结构与文档',
        examples: ['查 facebook/react 的仓库结构'],
      },
    },
  },
}))
assert.equal(httpSeed?.category, '知识检索')
assert.equal(httpSeed?.description, '查询 GitHub 仓库结构与文档')
assert.deepEqual(httpSeed?.examples, ['查 facebook/react 的仓库结构'])

const [stdioSeed] = parseMcpServers(JSON.stringify({
  mcpServers: {
    everything: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      'x-dsh': { examples: ['列出可用工具'] },
    },
  },
}))
assert.deepEqual(stdioSeed?.examples, ['列出可用工具'])
assert.equal(stdioSeed?.transport, 'stdio')

assert.throws(
  () => parseMcpServers(JSON.stringify({
    mcpServers: {
      bad: {
        url: 'https://example.com/mcp',
        'x-dsh': { examples: ['1', '2', '3', '4', '5', '6', '7'] },
      },
    },
  })),
  error => error?.code === 'invalid_examples',
)

assert.throws(
  () => parseMcpServers(JSON.stringify({
    mcpServers: {
      bad: {
        url: 'https://example.com/mcp',
        'x-dsh': 'nope',
      },
    },
  })),
  error => error?.code === 'invalid_server_config',
)

function makeService() {
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
  return new ConnectionService({
    loader: {},
    storageDomain: {
      open: async () => ({ table: tableFor, close: async () => {} }),
    },
  }, () => [])
}

const singleXdsh = JSON.stringify({
  mcpServers: {
    deepwiki: {
      url: 'https://mcp.deepwiki.com/mcp',
      'x-dsh': {
        description: 'JSON 描述',
        category: '知识检索',
        examples: ['JSON 示例'],
      },
    },
  },
})

const overridden = await makeService().importCustom(singleXdsh, false, {
  description: '表单描述',
  category: '开发工具',
  examples: ['表单示例'],
})
assert.equal(overridden[0]?.category, '开发工具')
assert.equal(overridden[0]?.summary, '表单描述')
assert.deepEqual(overridden[0]?.examples, ['表单示例'])

const fallback = await makeService().importCustom(singleXdsh, false, {})
assert.equal(fallback[0]?.category, '知识检索')
assert.equal(fallback[0]?.summary, 'JSON 描述')
assert.deepEqual(fallback[0]?.examples, ['JSON 示例'])

const multiXdsh = JSON.stringify({
  mcpServers: {
    alpha: {
      url: 'https://example.com/alpha',
      'x-dsh': { category: '知识检索' },
    },
    beta: {
      url: 'https://example.com/beta',
      'x-dsh': { category: '办公协作' },
    },
  },
})
const multiOverridden = await makeService().importCustom(multiXdsh, false, { category: '开发工具' })
assert.deepEqual(multiOverridden.map(card => card.category), ['开发工具', '开发工具'])
const multiFallback = await makeService().importCustom(multiXdsh, false, {})
assert.deepEqual(multiFallback.map(card => card.category), ['知识检索', '办公协作'])

const instanceCard = {
  id: 'gitlab-self-hosted',
  name: 'GitLab 自建',
  vendor: 'GitLab',
  category: '开发工具',
  summary: '',
  tags: [],
  published: true,
  auth: { type: 'oauth2', registration: 'dcr', scopes: ['mcp'] },
  server: { serverName: 'gitlab', transport: 'streamable-http', url: '{instance}/api/v4/mcp' },
  instance: { label: '实例地址' },
}

function baseInstanceRecord() {
  return {
    key: 'gitlab-self-hosted',
    connectorId: 'gitlab-self-hosted',
    name: 'GitLab 自建',
    serverName: 'gitlab',
    transport: 'streamable-http',
    url: 'https://old.example.com/api/v4/mcp',
    enabled: true,
    oauth: {
      provider: 'gitlab',
      clientId: 'client-id',
      tokenEndpoint: 'https://old.example.com/oauth/token',
      authorizationEndpoint: 'https://old.example.com/oauth/authorize',
      accessToken: 'old-token',
    },
    createdAt: 1,
    updatedAt: 2,
  }
}

function makeInstanceService(record) {
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
  const removed = []
  const service = new ConnectionService({
    loader: {
      resolve: () => ({}),
      remove: async id => {
        removed.push(id)
      },
    },
    storageDomain: {
      open: async () => ({ table: tableFor, close: async () => {} }),
    },
  }, () => [instanceCard])
  tableFor('connections').put(record.key, record)
  return { service, removed, table: tableFor('connections') }
}

const changed = makeInstanceService(baseInstanceRecord())
const changedView = await changed.service.reconfigureInstance('gitlab-self-hosted', 'https://new.example.com')
assert.equal(changedView.instanceReady, true)
assert.equal(changedView.authorized, false)
assert.equal(changed.table.get('gitlab-self-hosted')?.url, 'https://new.example.com/api/v4/mcp')
assert.equal(changed.table.get('gitlab-self-hosted')?.oauth, undefined)
assert.equal(changed.table.get('gitlab-self-hosted')?.createdAt, 1)
assert.deepEqual(changed.removed, ['dsh-connectors-gitlab-self-hosted'])

const same = makeInstanceService(baseInstanceRecord())
const sameView = await same.service.reconfigureInstance('gitlab-self-hosted', 'https://old.example.com')
assert.equal(sameView.authorized, true)
assert.ok(same.table.get('gitlab-self-hosted')?.oauth !== undefined)
assert.equal(same.removed.length, 0)

const invalid = makeInstanceService(baseInstanceRecord())
await assert.rejects(
  () => invalid.service.reconfigureInstance('gitlab-self-hosted', 'ftp://old.example.com'),
  error => error?.code === 'invalid_instance_url',
)
assert.equal(invalid.table.get('gitlab-self-hosted')?.url, 'https://old.example.com/api/v4/mcp')
assert.ok(invalid.table.get('gitlab-self-hosted')?.oauth !== undefined)

function makeCustomService() {
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
  const removed = []
  const service = new ConnectionService({
    loader: {
      resolve: () => ({}),
      remove: async id => {
        removed.push(id)
      },
    },
    storageDomain: {
      open: async () => ({ table: tableFor, close: async () => {} }),
    },
  }, () => [])
  return {
    service,
    removed,
    customTable: tableFor('custom_connectors'),
    connectionTable: tableFor('connections'),
  }
}

const originalConfig = JSON.stringify({
  mcpServers: {
    github11: {
      url: 'https://api.example.com/mcp?token=url-secret',
      headers: {
        Authorization: 'Bearer header-secret',
        'X-Client': 'dsh',
      },
    },
  },
})
const custom = makeCustomService()
await custom.service.importCustom(originalConfig, false)

const redacted = await custom.service.customConfig('custom-github11')
assert.equal(redacted.installed, false)
assert.ok(!redacted.json.includes('url-secret'))
assert.ok(!redacted.json.includes('header-secret'))
assert.ok(redacted.json.includes(CUSTOM_SECRET_PLACEHOLDER))

custom.connectionTable.put('custom-github11', {
  key: 'custom-github11',
  connectorId: 'custom-github11',
  name: 'github11',
  serverName: 'github11',
  transport: 'streamable-http',
  url: 'https://api.example.com/mcp?token=url-secret',
  headers: {
    Authorization: 'Bearer header-secret',
    'X-Client': 'dsh',
  },
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
})

const sameConfig = JSON.stringify({
  mcpServers: {
    github11: {
      url: `https://api.example.com/mcp?${CUSTOM_SECRET_PLACEHOLDER}`,
      headers: {
        Authorization: CUSTOM_SECRET_PLACEHOLDER,
        'X-Client': 'dsh',
      },
      'x-dsh': {
        category: '知识检索',
        description: '旧描述',
      },
    },
  },
})
const metadataOnly = await custom.service.updateCustom('custom-github11', sameConfig, false, {
  category: '开发工具',
  description: '新描述',
  examples: ['新示例'],
})
assert.equal(metadataOnly.disconnected, false)
assert.equal(metadataOnly.card.category, '开发工具')
const mergedRecord = custom.customTable.get('custom-github11')
assert.equal(mergedRecord?.url, 'https://api.example.com/mcp?token=url-secret')
assert.equal(mergedRecord?.headers?.Authorization, 'Bearer header-secret')
assert.equal(mergedRecord?.headers?.['X-Client'], 'dsh')
assert.equal(mergedRecord?.description, '新描述')
assert.deepEqual(mergedRecord?.examples, ['新示例'])
assert.ok(custom.connectionTable.get('custom-github11') !== undefined)
assert.equal(custom.removed.length, 0)

const changedConfig = JSON.stringify({
  mcpServers: {
    github11: {
      url: 'https://new.example.com/mcp?token=new-secret',
      headers: {
        Authorization: 'Bearer new-header',
        'X-Client': 'dsh',
      },
    },
  },
})
const changedCustom = await custom.service.updateCustom('custom-github11', changedConfig, false, {
  category: '开发工具',
  description: '新描述',
  examples: ['新示例'],
})
assert.equal(changedCustom.disconnected, true)
assert.equal(custom.connectionTable.get('custom-github11'), undefined)
assert.deepEqual(custom.removed, ['dsh-connectors-custom-github11'])
assert.equal(custom.customTable.get('custom-github11')?.url, 'https://new.example.com/mcp?token=new-secret')

const badCustom = makeCustomService()
await badCustom.service.importCustom(originalConfig, false)
await assert.rejects(
  () => badCustom.service.updateCustom('custom-github11', JSON.stringify({
    mcpServers: {
      github11: {
        url: 'https://api.example.com/mcp',
        headers: { 'X-New': CUSTOM_SECRET_PLACEHOLDER },
      },
    },
  }), false),
  error => error?.code === 'invalid_custom_config',
)

console.log('custom metadata tests: passed')
