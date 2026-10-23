import { ConnectError } from './errors.js'

export type CustomTransport = 'streamable-http' | 'stdio'

export interface McpServerSeed {
  serverName: string
  connectorId: string
  transport: CustomTransport
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const MAX_SERVERS = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ConnectError('invalid_server_config', `${label} 必须是字符串`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new ConnectError('invalid_server_config', `${label} 必须是对象`)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new ConnectError('invalid_server_config', `${label}.${key} 必须是字符串`)
    }
    out[key] = item
  }
  return out
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new ConnectError('invalid_server_config', `${label} 必须是数组`)
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new ConnectError('invalid_server_config', `${label}[${index}] 必须是字符串`)
    }
    return item
  })
}

function parseServer(serverName: string, raw: unknown): McpServerSeed {
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new ConnectError(
      'invalid_server_name',
      `serverName "${serverName}" 非法，只允许 1-32 位字母、数字、下划线或短横线`,
    )
  }
  if (!isRecord(raw)) {
    throw new ConnectError('invalid_server_config', `${serverName} 的配置必须是对象`)
  }

  const url = optionalString(raw.url, `${serverName}.url`)
  const command = optionalString(raw.command, `${serverName}.command`)
  if (url !== undefined && command !== undefined) {
    throw new ConnectError('invalid_server_config', `${serverName} 不能同时配置 url 与 command`)
  }
  if (url === undefined && command === undefined) {
    throw new ConnectError('invalid_server_config', `${serverName} 需要配置 url 或 command`)
  }

  if (url !== undefined) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
    } catch {
      throw new ConnectError('invalid_server_url', `${serverName} 的 url 必须是合法的 http(s) 地址`)
    }
    const headers = stringRecord(raw.headers, `${serverName}.headers`)
    return {
      serverName,
      connectorId: `custom-${serverName}`,
      transport: 'streamable-http',
      url,
      ...(headers === undefined ? {} : { headers }),
    }
  }

  if (command === undefined) {
    throw new ConnectError('invalid_server_config', `${serverName} 需要配置 command`)
  }
  const args = stringArray(raw.args, `${serverName}.args`)
  const env = stringRecord(raw.env, `${serverName}.env`)
  const cwd = optionalString(raw.cwd, `${serverName}.cwd`)
  return {
    serverName,
    connectorId: `custom-${serverName}`,
    transport: 'stdio',
    command,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
  }
}

export function parseMcpServers(text: string): McpServerSeed[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ConnectError('invalid_json', `JSON 解析失败：${message}`)
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new ConnectError('invalid_mcp_servers', 'JSON 必须包含 mcpServers 对象')
  }
  const entries = Object.entries(parsed.mcpServers)
  if (entries.length === 0) {
    throw new ConnectError('invalid_mcp_servers', 'mcpServers 至少需要一个 MCP Server')
  }
  if (entries.length > MAX_SERVERS) {
    throw new ConnectError('invalid_mcp_servers', `一次最多导入 ${MAX_SERVERS} 个 MCP Server`)
  }
  return entries.map(([serverName, raw]) => parseServer(serverName, raw))
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true
  if (host === 'host.docker.internal' || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true
  const private172 = /^172\.(\d{1,3})\./.exec(host)
  if (private172 !== null) {
    const second = Number(private172[1] ?? '')
    if (second >= 16 && second <= 31) return true
  }
  if (host.includes(':')) {
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
  }
  return false
}

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return url
  }
}

export function privateUrlsFor(seeds: McpServerSeed[]): string[] {
  return seeds.flatMap(seed => {
    if (seed.url === undefined) return []
    try {
      return isPrivateHost(new URL(seed.url).hostname) ? [displayUrl(seed.url)] : []
    } catch {
      return []
    }
  })
}

export function assertPrivateUrlsAllowed(seeds: McpServerSeed[], allowPrivate: boolean): void {
  if (allowPrivate) return
  const urls = privateUrlsFor(seeds)
  if (urls.length === 0) return
  throw new ConnectError(
    'private_url_confirmation',
    `以下地址指向本机或内网：${urls.join('、')}。确认允许访问后重试。`,
  )
}
