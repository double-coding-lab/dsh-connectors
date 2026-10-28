import assert from 'node:assert/strict'

import { CLI_ADAPTERS } from '../dist/host/cli/adapters.js'
import { redactOutput } from '../dist/host/cli/exec.js'

const dingtalk = CLI_ADAPTERS.dingtalk
const feishu = CLI_ADAPTERS.feishu

assert.ok(dingtalk.install.some(step => step.args.includes('dingtalk-workspace-cli')), 'dingtalk install package')
assert.ok(dingtalk.uninstall.some(step => step.args.includes('uninstall') && step.args.includes('dingtalk-workspace-cli')), 'dingtalk uninstall package')
assert.ok(dingtalk.auth.login.args.includes('--device'), 'dingtalk device login')
assert.ok(dingtalk.auth.status.args.includes('--format') && dingtalk.auth.status.args.includes('json'), 'dingtalk json status')

assert.ok(feishu.install.some(step => step.args.includes('@larksuite/cli')), 'feishu cli install')
assert.ok(feishu.install.some(step => step.args.includes('skills') && step.args.includes('larksuite/cli')), 'feishu skills install')
assert.ok(feishu.uninstall.some(step => step.args.includes('uninstall') && step.args.includes('@larksuite/cli')), 'feishu uninstall package')
assert.ok(feishu.auth.prepare !== undefined, 'feishu needs config init')
assert.ok(feishu.auth.prepare.args.includes('--new'), 'feishu config init creates a fresh app')
assert.equal(feishu.auth.login.args.at(-1), '--recommend', 'feishu recommend login')
assert.deepEqual(feishu.unsetEnv, ['HERMES_HOME', 'OPENCLAW_HOME'])
assert.equal(dingtalk.unsetEnv, undefined)

const jsonStatus = dingtalk.parseStatus(JSON.stringify({
  authenticated: true,
  userName: '张三',
  email: 'zhangsan@example.com',
  corpName: '示例公司',
}))
assert.equal(jsonStatus.authenticated, true)
assert.equal(jsonStatus.account?.name, '张三')
assert.equal(jsonStatus.account?.email, 'zhangsan@example.com')
assert.equal(jsonStatus.account?.org, '示例公司')

const dwsCapabilities = dingtalk.capabilities.parse(JSON.stringify({
  agent_metadata: { surface_tools: 1501 },
  products: [{ id: 'aitable', agent_summary: '管理 AI 表格', tool_count: 285 }],
}))
assert.equal(dwsCapabilities.kind, 'products')
assert.equal(dwsCapabilities.total, 1501)
assert.equal(dwsCapabilities.items[0]?.name, 'aitable')
assert.equal(dwsCapabilities.items[0]?.count, 285)

const larkCapabilities = feishu.capabilities.parse(`notice\n${JSON.stringify({
  skills: [{ name: 'lark-im', description: '飞书即时通讯' }],
})}`)
assert.equal(larkCapabilities.kind, 'skills')
assert.equal(larkCapabilities.total, 1)
assert.equal(larkCapabilities.items[0]?.description, '飞书即时通讯')

const larkStatus = feishu.parseStatus(JSON.stringify({
  identity: 'user',
  identities: {
    bot: { status: 'ready', available: true },
    user: { status: 'ready', available: true, userName: '李国川', tokenStatus: 'valid', openId: 'ou_test' },
  },
}))
assert.equal(larkStatus.authenticated, true)
assert.equal(larkStatus.account?.name, '李国川')
assert.equal(feishu.parseStatus(JSON.stringify({
  identities: { user: { status: 'expired', available: false } },
})).authenticated, false)

const dwsStatus = dingtalk.parseStatus(JSON.stringify({
  authenticated: true,
  user_name: '李国川',
  corp_name: '本地测试',
}))
assert.equal(dwsStatus.authenticated, true)
assert.equal(dwsStatus.account?.name, '李国川')
assert.equal(dwsStatus.account?.org, '本地测试')

assert.equal(dingtalk.parseStatus('{"loggedIn":false}').authenticated, false)
assert.equal(dingtalk.parseStatus('当前未登录，请先执行 dws auth login').authenticated, false)
assert.equal(dingtalk.parseStatus('账号已登录：李四').authenticated, true)

const linkHint = dingtalk.parseLoginHint('请在浏览器打开 https://example.com/device?code=ABC 完成登录')
assert.equal(linkHint.link, 'https://example.com/device?code=ABC')

const codeHint = dingtalk.parseLoginHint('设备码：AB12-CD34')
assert.equal(codeHint.code, 'AB12-CD34')

const redacted = redactOutput([
  'Authorization: Bearer abcdefgh12345678',
  'access_token=secret-value',
  'client_secret: topsecret',
].join('\n'))
assert.equal(redacted.includes('abcdefgh12345678'), false)
assert.equal(redacted.includes('secret-value'), false)
assert.equal(redacted.includes('topsecret'), false)
assert.match(redacted, /access_token=\*\*\*/)
assert.match(redacted, /client_secret: \*\*\*/)

console.log('cli adapter tests: passed')
