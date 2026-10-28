import assert from 'node:assert/strict'

import { providerDefinitionSchema } from '../dist/host/providers.js'

const base = {
  schemaVersion: 1,
  id: 'example-instance',
  name: 'Example',
  category: '开发工具',
  summary: 'test',
  auth: {
    type: 'oauth2',
    flow: 'pkce',
    registration: 'dcr',
    scopes: ['mcp'],
  },
  server: {
    serverName: 'example-instance',
    transport: 'streamable-http',
  },
  instance: { label: '服务地址' },
}

assert.equal(providerDefinitionSchema.safeParse(base).success, true, 'instance without url should pass')

const instanceWithUrl = {
  ...base,
  server: { ...base.server, url: 'https://example.com/mcp' },
}
assert.equal(providerDefinitionSchema.safeParse(instanceWithUrl).success, false, 'instance with url should fail')

const missingUrl = {
  ...base,
}
delete missingUrl.instance
assert.equal(providerDefinitionSchema.safeParse(missingUrl).success, false, 'missing url without instance should fail')

const missingLabel = {
  ...base,
  instance: {},
}
assert.equal(providerDefinitionSchema.safeParse(missingLabel).success, false, 'instance label should be required')

const plainHttps = {
  ...base,
}
delete plainHttps.instance
plainHttps.server = { ...base.server, url: 'https://example.com/mcp' }
assert.equal(providerDefinitionSchema.safeParse(plainHttps).success, true, 'https without instance should pass')

const plainHttp = {
  ...plainHttps,
  server: { ...plainHttps.server, url: 'http://example.com/mcp' },
}
assert.equal(providerDefinitionSchema.safeParse(plainHttp).success, false, 'http without instance should fail')

const instanceNone = {
  ...base,
  auth: { type: 'none' },
}
assert.equal(providerDefinitionSchema.safeParse(instanceNone).success, true, 'instance with none auth should pass')

const instanceHelp = {
  ...instanceNone,
  instance: {
    ...base.instance,
    help: { url: 'https://example.com/docs/mcp', label: '查看接入指引' },
  },
}
assert.equal(providerDefinitionSchema.safeParse(instanceHelp).success, true, 'instance help with https should pass')

const instanceHelpHttp = {
  ...instanceHelp,
  instance: {
    ...instanceHelp.instance,
    help: { url: 'http://example.com/docs/mcp', label: '查看接入指引' },
  },
}
assert.equal(providerDefinitionSchema.safeParse(instanceHelpHttp).success, false, 'instance help with http should fail')

console.log('provider schema instance tests: 9 passed')
