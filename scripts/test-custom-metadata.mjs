import assert from 'node:assert/strict'

import { canonicalizeCardCategories, parseExampleLines, resolveCategory, validateCategory } from '../dist/shared/categories.js'
import { parseMcpServers } from '../dist/host/mcpServers.js'
import { ConnectionService } from '../dist/host/connections.js'

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

console.log('custom metadata tests: passed')
