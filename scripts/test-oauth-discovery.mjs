import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { buildAuthorizeUrl, fetchOAuthMetadata, registerOAuthClient } from '../dist/host/oauth.js'

function listen(handler) {
  return new Promise(resolve => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, origin: `http://127.0.0.1:${port}` })
    })
  })
}

const authorizationServer = origin => ({
  issuer: `${origin}/as`,
  authorization_endpoint: `${origin}/as/authorize`,
  token_endpoint: `${origin}/as/token`,
  registration_endpoint: `${origin}/as/register`,
  scopes_supported: ['mcp:tools'],
})

// 1. 401 的 WWW-Authenticate 给出 resource_metadata，且元数据在非标准路径
{
  const { server, origin } = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer error="invalid_token", resource_metadata="${origin}/advertised-meta"`,
      })
      res.end('{"error":"invalid_token"}')
      return
    }
    if (req.url === '/advertised-meta') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/as`], scopes_supported: ['mcp:tools'] }))
      return
    }
    if (req.url === '/as/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(authorizationServer(origin)))
      return
    }
    res.writeHead(404).end('not found')
  })
  const metadata = await fetchOAuthMetadata(`${origin}/mcp`)
  assert.equal(metadata.authorizationEndpoint, `${origin}/as/authorize`)
  assert.equal(metadata.registrationEndpoint, `${origin}/as/register`)
  assert.equal(metadata.scope, 'mcp:tools')
  assert.equal(metadata.resource, `${origin}/mcp`)
  const authorizeUrl = buildAuthorizeUrl(metadata, {
    clientId: 'client-1',
    redirectUri: `${origin}/callback`,
    state: 'state-1',
    challenge: 'challenge-1',
  })
  assert.equal(new URL(authorizeUrl).searchParams.get('resource'), `${origin}/mcp`)
  server.close()
  console.log('✓ 优先使用 401 响应里的 resource_metadata')
}

// 2. 无 challenge，退回 RFC 9728 的 {origin}/.well-known/oauth-protected-resource{path}
{
  const { server, origin } = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"invalid_token"}')
      return
    }
    if (req.url === '/.well-known/oauth-protected-resource/mcp') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ authorization_servers: [`${origin}/as`] }))
      return
    }
    if (req.url === '/as/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(authorizationServer(origin)))
      return
    }
    res.writeHead(404).end('not found')
  })
  const metadata = await fetchOAuthMetadata(`${origin}/mcp`)
  assert.equal(metadata.tokenEndpoint, `${origin}/as/token`)
  server.close()
  console.log('✓ 兼容 {origin}/.well-known/oauth-protected-resource{path}')
}

// 3. 只有 {resource}/.well-known/oauth-protected-resource 形式（腾讯文档、企查查）
{
  const { server, origin } = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"invalid_token"}')
      return
    }
    if (req.url === '/mcp/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ authorization_servers: [`${origin}/as`], scopes_supported: ['docs:read', 'docs:write'] }))
      return
    }
    if (req.url === '/as/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(authorizationServer(origin)))
      return
    }
    res.writeHead(404).end('not found')
  })
  const metadata = await fetchOAuthMetadata(`${origin}/mcp`)
  assert.equal(metadata.scope, 'docs:read')
  server.close()
  console.log('✓ 兼容 {resource}/.well-known/oauth-protected-resource')
}

// 4. 全部缺失时明确报错，不静默成功
{
  const { server, origin } = await listen((req, res) => {
    res.writeHead(404).end('not found')
  })
  await assert.rejects(() => fetchOAuthMetadata(`${origin}/mcp`), /OAuth/)
  server.close()
  console.log('✓ 元数据缺失时报错')
}

// 5. provider 声明空 scopes 时不请求 scope：授权 URL 与 DCR 请求都不带 scope
{
  let registrationBody = null
  const { server, origin } = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/register') {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        registrationBody = JSON.parse(raw)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ client_id: 'client-no-scope' }))
      })
      return
    }
    res.writeHead(404).end('not found')
  })
  const metadata = {
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    registrationEndpoint: `${origin}/register`,
    scope: '',
    resource: `${origin}/mcp`,
  }
  const client = await registerOAuthClient(metadata, `${origin}/callback`, 'DSH 连接器')
  assert.equal(client.clientId, 'client-no-scope')
  assert.equal(Object.hasOwn(registrationBody, 'scope'), false, 'registration 不应带 scope')
  const authorizeUrl = buildAuthorizeUrl(metadata, {
    clientId: client.clientId,
    redirectUri: `${origin}/callback`,
    state: 'state-2',
    challenge: 'challenge-2',
  })
  assert.equal(new URL(authorizeUrl).searchParams.has('scope'), false, '授权 URL 不应带 scope')
  assert.equal(new URL(authorizeUrl).searchParams.get('resource'), `${origin}/mcp`)
  server.close()
  console.log('✓ 空 scopes 时不带 scope（授权与注册）')
}

console.log('oauth discovery tests: 6 passed')
