import assert from 'node:assert/strict'

import { providerDefinitionSchema } from '../dist/host/providers.js'

const base = {
  schemaVersion: 1,
  id: 'gitlab-self-hosted',
  name: 'GitLab 自建',
  category: '开发工具',
  summary: 'test',
  auth: {
    type: 'oauth2',
    flow: 'pkce',
    registration: 'dcr',
    scopes: ['mcp'],
  },
  server: {
    serverName: 'gitlab-self-hosted',
    transport: 'streamable-http',
    url: '{instance}/api/v4/mcp',
  },
  instance: { label: 'GitLab 实例地址' },
}

assert.equal(providerDefinitionSchema.safeParse(base).success, true, 'instance template should pass')

const noInstanceTemplate = {
  ...base,
  instance: undefined,
}
delete noInstanceTemplate.instance
assert.equal(providerDefinitionSchema.safeParse(noInstanceTemplate).success, false, 'template without instance should fail')

const instanceAbsolute = {
  ...base,
  server: { ...base.server, url: 'https://example.com/api/v4/mcp' },
}
assert.equal(providerDefinitionSchema.safeParse(instanceAbsolute).success, false, 'absolute url with instance should fail')

const missingLabel = {
  ...base,
  instance: {},
}
assert.equal(providerDefinitionSchema.safeParse(missingLabel).success, false, 'instance label should be required')

const plainHttps = {
  ...base,
}
delete plainHttps.instance
plainHttps.server = { ...base.server, url: 'https://example.com/api/v4/mcp' }
assert.equal(providerDefinitionSchema.safeParse(plainHttps).success, true, 'https without instance should pass')

const plainHttp = {
  ...plainHttps,
  server: { ...plainHttps.server, url: 'http://example.com/api/v4/mcp' },
}
assert.equal(providerDefinitionSchema.safeParse(plainHttp).success, false, 'http without instance should fail')

console.log('provider schema instance tests: 6 passed')
