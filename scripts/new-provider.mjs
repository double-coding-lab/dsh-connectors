import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const id = args.find(arg => !arg.startsWith('--'))
const authIndex = args.indexOf('--auth')
const authType = authIndex >= 0 ? args[authIndex + 1] : 'bearer'
const nameIndex = args.indexOf('--name')
const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined

if (id === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error('用法：npm run provider:new -- <id> [--auth none|bearer|header|oauth2] [--name "显示名称"]')
  console.error('id 只能包含小写字母、数字和连字符，例如：acme-docs')
  process.exit(1)
}
if (!['none', 'bearer', 'header', 'oauth2'].includes(authType)) {
  console.error(`不支持的 --auth：${authType}，可选 none / bearer / header / oauth2`)
  process.exit(1)
}

const providerDir = join(root, 'providers', id)
if (existsSync(providerDir)) {
  console.error(`providers/${id} 已存在，请换一个 id`)
  process.exit(1)
}

const displayName = name ?? id.replace(/(^|-)([a-z])/g, (_, lead, char) => `${lead === '-' ? ' ' : ''}${char.toUpperCase()}`)

const auth = {
  none: { type: 'none' },
  bearer: {
    type: 'bearer',
    label: 'API Key',
    help: {
      url: 'https://example.com/tokens',
      label: '创建 API Key',
      hint: 'TODO：说明创建入口；令牌只保存在本机。',
    },
  },
  header: {
    type: 'header',
    header: 'X-API-Key',
    label: 'API Key',
    help: {
      url: 'https://example.com/tokens',
      label: '创建 API Key',
      hint: 'TODO：说明创建入口；令牌只保存在本机。',
    },
  },
  oauth2: {
    type: 'oauth2',
    flow: 'pkce',
    registration: 'dcr',
    scopes: ['mcp'],
    clientName: 'DSH 连接器',
  },
}[authType]

const provider = {
  $schema: '../../schema/provider.schema.json',
  schemaVersion: 1,
  id,
  name: displayName,
  vendor: displayName,
  category: '其他',
  summary: 'TODO：一句话说明这个 MCP 服务提供什么。',
  description: 'TODO：补充服务说明与安装后的凭据获取方式。',
  examples: ['TODO：写一条你希望用户直接尝试的提示词'],
  tags: [],
  order: 100,
  server: {
    serverName: id,
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
  },
  auth,
}

mkdirSync(providerDir, { recursive: true })
writeFileSync(join(providerDir, 'provider.json'), `${JSON.stringify(provider, null, 2)}\n`)

console.log(`已创建 providers/${id}/provider.json（auth: ${authType}）`)
console.log('下一步：')
console.log('  1. 填写 summary / description / examples，替换服务器地址与凭据帮助链接')
console.log('  2. 可选：放入 providers/' + id + '/icon.svg（或 .png / .webp），缺省用首字母兜底')
console.log('  3. 运行 npm run check 校验并构建')
