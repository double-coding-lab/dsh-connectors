import assert from 'node:assert/strict'

import { CLI_ADAPTERS } from '../dist/host/cli/adapters.js'
import { CliConnectorService } from '../dist/host/cli/service.js'

const table = {
  get: () => undefined,
  put: async () => undefined,
  delete: async () => undefined,
}
const domain = {
  table: () => table,
  close: async () => undefined,
}
const service = new CliConnectorService({
  storageDomain: { open: async () => domain },
})

const base = {
  name: '飞书',
  vendor: '飞书',
  description: '',
  category: '办公协作',
  docsUrl: '',
  examples: [],
  installHint: [],
  installed: false,
  enabled: true,
  authenticated: false,
  skills: { installed: false, count: 0, names: [] },
  phase: 'idle',
}

service.cache.set('feishu', { ...base, id: 'feishu' })
service.jobs.set('feishu', {
  connectorId: 'feishu',
  kind: 'install',
  phase: 'installing',
  stage: '安装',
  output: 'installing packages',
  cancel: false,
  done: true,
  settled: false,
})

let connectors = await service.list()
let feishu = connectors.find(connector => connector.id === 'feishu')
assert.equal(feishu.phase, 'installing')
assert.equal(feishu.installed, false)

service.cache.set('feishu', { ...base, id: 'feishu', installed: true, version: '1.0.98' })
service.jobs.get('feishu').settled = true

connectors = await service.list()
feishu = connectors.find(connector => connector.id === 'feishu')
assert.equal(feishu.phase, 'idle')
assert.equal(feishu.installed, true)

service.cache.set('dingtalk', {
  ...base,
  id: 'dingtalk',
  name: '钉钉',
  installed: true,
  authenticated: true,
})
service.jobs.set('dingtalk', {
  connectorId: 'dingtalk',
  kind: 'login',
  phase: 'error',
  stage: '登录',
  output: 'kpi request failed',
  cancel: false,
  done: true,
  settled: true,
  error: '登录失败：kpi request failed',
})

connectors = await service.list()
const dingtalk = connectors.find(connector => connector.id === 'dingtalk')
assert.equal(dingtalk.phase, 'idle')
assert.equal(dingtalk.lastError, undefined)

const fakeAdapter = {
  id: 'fake',
  name: 'Fake CLI',
  vendor: 'Fake',
  description: '',
  category: '办公协作',
  docsUrl: '',
  examples: [],
  bin: 'fake-cli',
  versionArgs: ['--version'],
  install: [],
  uninstall: [{ label: '卸载 fake CLI', command: process.execPath, args: ['-e', '0'] }],
  skills: { expectedPrefix: 'fake-skill-', expected: [] },
  auth: {
    login: { command: 'fake-cli', args: ['login'] },
    status: { command: 'fake-cli', args: ['status'] },
    logout: { command: 'fake-cli', args: ['logout'] },
  },
  parseStatus: () => ({ authenticated: false }),
  parseLoginHint: () => ({}),
}
CLI_ADAPTERS.fake = fakeAdapter
const commands = []
const deleted = []
const fakeTable = {
  get: () => undefined,
  put: async () => undefined,
  delete: async key => { deleted.push(key) },
}
const fakeService = new CliConnectorService(
  { storageDomain: { open: async () => ({ table: () => fakeTable, close: async () => undefined }) } },
  async (command, args) => {
    commands.push([command, ...args].join(' '))
    const stdout = command === 'where' ? `fake-cli${String.fromCharCode(10)}` : ''
    return { stdout, stderr: '', code: 0, timedOut: false }
  },
)
const started = await fakeService.startUninstall('fake')
assert.equal(started.phase, 'uninstalling')
let finished = started
for (let attempt = 0; attempt < 50; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 20))
  const current = (await fakeService.list()).find(connector => connector.id === 'fake')
  if (current !== undefined) finished = current
  if (finished.phase === 'idle' && !finished.installed) break
}
assert.equal(finished.installed, false)
assert.deepEqual(deleted, ['fake'])
delete CLI_ADAPTERS.fake
await fakeService.dispose()

await service.dispose()
console.log('cli service tests: passed')
