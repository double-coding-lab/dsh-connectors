import assert from 'node:assert/strict'

import { requestOAuthCallback } from '../dist/host/routes.js'

assert.equal(
  requestOAuthCallback({ headers: { host: '127.0.0.1:3080' } }),
  'http://127.0.0.1:3080/dsh-connectors/api/oauth/callback',
)
assert.equal(
  requestOAuthCallback({ headers: { host: 'localhost:3080', 'x-forwarded-proto': 'https' } }),
  'https://localhost:3080/dsh-connectors/api/oauth/callback',
)
assert.equal(
  requestOAuthCallback({ headers: { host: '127.0.0.1:3080', 'x-forwarded-host': 'localhost:3080' } }),
  'http://localhost:3080/dsh-connectors/api/oauth/callback',
)
assert.equal(requestOAuthCallback({ headers: {} }), undefined)

console.log('oauth callback tests: passed')
