import assert from 'node:assert/strict'

import { CLI_ADAPTERS } from '../dist/host/cli/adapters.js'
import { redactOutput } from '../dist/host/cli/exec.js'
import { compareVersions } from '../dist/host/cli/version.js'

const dingtalk = CLI_ADAPTERS.dingtalk
const feishu = CLI_ADAPTERS.feishu
const tmeet = CLI_ADAPTERS.tmeet
const wecom = CLI_ADAPTERS.wecom

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

assert.ok(tmeet.install.some(step => step.args.includes('@tencentcloud/tmeet')), 'tmeet cli install')
assert.ok(tmeet.install.some(step => step.args.includes('TencentCloud/tencentmeeting-cli')), 'tmeet skills install')
assert.ok(tmeet.uninstall.some(step => step.args.includes('uninstall') && step.args.includes('@tencentcloud/tmeet')), 'tmeet uninstall package')
assert.ok(tmeet.auth.login.args.includes('--no-browser'), 'tmeet login prints url instead of opening browser')
assert.deepEqual(tmeet.auth.status.args, ['auth', 'status', '--format', 'json'])
assert.equal(tmeet.auth.prepare, undefined, 'tmeet login sets up config itself')

const tmeetHelp = [
  'tmeet CLI — OAuth authorization, API calls',
  '',
  'Available Commands:',
  '  app         about app operator cmd',
  '  auth        Authentication commands',
  '  completion  Generate the autocompletion script for the specified shell',
  '  contact     about contact operator cmd',
  '  control     about in-meeting control operator cmd',
  '  event       Real-time event consumption',
  '  help        Help about any command',
  '  meeting     about meeting operator cmd',
  '  minutes     minutes related commands',
  '  record      record related commands',
  '  report      about report operator cmd',
  '  tshoot      about troubleshoot operator cmd',
  '',
  'Flags:',
  '      --compact         compact output',
].join('\n')
const tmeetCapabilities = tmeet.capabilities.parse(tmeetHelp)
assert.equal(tmeetCapabilities.kind, 'groups')
assert.equal(tmeetCapabilities.total, 10)
assert.ok(tmeetCapabilities.items.some(item => item.name === 'meeting' && item.description === '会议预约、查询与邀请人'))
assert.ok(!tmeetCapabilities.items.some(item => item.name === 'help' || item.name === 'completion'))

const tmeetHint = tmeet.parseLoginHint('authorize url: https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=DkDYvPMLLfGF')
assert.equal(tmeetHint.link, 'https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=DkDYvPMLLfGF')
assert.equal(tmeet.parseStatus("Not logged in. Please use 'tmeet auth login' to authenticate.").authenticated, false)

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

assert.ok(wecom.install.some(step => step.args.includes('@wecom/cli')), 'wecom cli install')
assert.ok(wecom.install.some(step => step.args.includes('WeComTeam/wecom-cli')), 'wecom skills install')
assert.ok(wecom.auth.login.args.includes('--noninteractive'), 'wecom noninteractive login')
assert.ok(wecom.auth.login.args.includes('--no-browser'), 'wecom login leaves browser to host')
assert.equal(wecom.auth.logout, undefined, 'wecom has no logout command')
assert.ok(wecom.logoutFiles !== undefined && wecom.logoutFiles.files.includes('credentials.enc'), 'wecom logout removes credential files')
assert.equal(wecom.logoutFiles.envDir, 'WECOM_CLI_CONFIG_DIR')

const wecomHelp = [
  'Usage: wecom-cli.exe [COMMAND]',
  '',
  'Commands:',
  '  auth        企业微信机器人授权管理',
  '  calendar    日历服务，提供日程创建、查询、取消、忙闲查询、搜索等能力',
  '  message     消息服务，提供消息发送、消息媒体内容获取等能力',
  '  help        Print this message or the help of the given subcommand(s)',
  '',
  'Options:',
  '  -h, --help     Print help',
].join('\n')
const wecomCapabilities = wecom.capabilities.parse(wecomHelp)
assert.equal(wecomCapabilities.kind, 'groups')
assert.equal(wecomCapabilities.total, 2)
assert.ok(wecomCapabilities.items.some(item => item.name === 'message' && item.description.startsWith('消息服务')))
assert.ok(!wecomCapabilities.items.some(item => item.name === 'auth' || item.name === 'help'))

assert.equal(wecom.parseStatus('Status: unauthorized').authenticated, false)
const wecomAuthorized = wecom.parseStatus('Status: authorized\nBot ID: aib29EBLvRg-WZQzqevNkJbI2b-YPQgTyEU')
assert.equal(wecomAuthorized.authenticated, true)
assert.equal(wecomAuthorized.account, undefined, 'Bot ID 不应作为账号名展示')
const wecomNamed = wecom.parseStatus('Status: authorized\nBot ID: bot_123\n机器人名称: 会议助手')
assert.equal(wecomNamed.account?.name, '会议助手')

assert.equal(compareVersions('1.3.4', '1.2.1'), 1)
assert.equal(compareVersions('1.2.1', '1.2.1'), 0)
assert.equal(compareVersions('v1.1.0', '1.2.1'), -1)
assert.equal(compareVersions('1.2.1-beta.2', '1.2.1'), 0)
assert.equal(wecom.minVersion, '1.2.1')

console.log('cli adapter tests: passed')
