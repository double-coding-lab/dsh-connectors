import assert from 'node:assert/strict'

import { resolveInstanceUrl } from '../dist/host/instanceUrl.js'

const valid = [
  'http://10.36.11.242/api/v4/mcp',
  'https://example.com/gitlab/api/v4/mcp',
  'https://example.com/gitlab/api/v4/mcp/',
  'https://mcp.amap.com/mcp?key=test-key',
  'https://mcp.feishu.cn/mcp',
]

for (const input of valid) {
  assert.equal(resolveInstanceUrl(input), new URL(input.trim()).href, input)
}

assert.equal(resolveInstanceUrl('  https://example.com  '), 'https://example.com/')

const invalid = [
  ['', 'invalid_instance_url'],
  ['example.com', 'invalid_instance_url'],
  ['ftp://example.com', 'invalid_instance_url'],
  ['https://user:pass@example.com', 'invalid_instance_url'],
  ['https://example.com#x', 'invalid_instance_url'],
]

for (const [input, code] of invalid) {
  assert.throws(
    () => resolveInstanceUrl(input),
    error => error?.code === code,
    input,
  )
}

console.log(`instance url tests: ${valid.length} valid, ${invalid.length} invalid`)
