import assert from 'node:assert/strict'

import { resolveInstanceMcpUrl } from '../dist/host/instanceUrl.js'

const cases = [
  ['http://10.36.11.242', 'http://10.36.11.242', 'http://10.36.11.242/api/v4/mcp'],
  ['https://example.com/gitlab/', 'https://example.com/gitlab', 'https://example.com/gitlab/api/v4/mcp'],
  ['https://example.com/gitlab/api/v4/mcp', 'https://example.com/gitlab', 'https://example.com/gitlab/api/v4/mcp'],
  ['https://example.com/api/v4/mcp/', 'https://example.com', 'https://example.com/api/v4/mcp'],
  ['  https://example.com  ', 'https://example.com', 'https://example.com/api/v4/mcp'],
]

for (const [input, instanceUrl, mcpUrl] of cases) {
  assert.deepEqual(resolveInstanceMcpUrl(input), { instanceUrl, mcpUrl }, input)
}

const invalid = [
  ['', 'invalid_instance_url'],
  ['example.com', 'invalid_instance_url'],
  ['ftp://example.com', 'invalid_instance_url'],
  ['https://user:pass@example.com', 'invalid_instance_url'],
  ['https://example.com?x=1', 'invalid_instance_url'],
  ['https://example.com#x', 'invalid_instance_url'],
]

for (const [input, code] of invalid) {
  assert.throws(
    () => resolveInstanceMcpUrl(input),
    error => error?.code === code,
    input,
  )
}

console.log(`instance url tests: ${cases.length} valid, ${invalid.length} invalid`)
