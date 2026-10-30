import { createHash } from 'node:crypto'

import { ConnectError } from './errors.js'
import { MAX_EXAMPLES } from '../shared/categories.js'
import type { CustomTranslations } from '../shared/types.js'

export type CustomTransport = 'streamable-http' | 'sse' | 'stdio'

export interface McpServerSeed {
  serverName: string
  displayName: string
  connectorId: string
  transport: CustomTransport
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  category?: string
  description?: string
  examples?: string[]
  translations?: CustomTranslations
}

const CONFIG_NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_CONFIG_NAME_LENGTH = 128
const MAX_SERVERS = 20

function toDshServerName(displayName: string): string {
  const withoutScope = displayName.startsWith('@') ? displayName.slice(1) : displayName
  const base = withoutScope.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp-server'
  const prefixed = /^[A-Za-z0-9]/.test(base) ? base : `m-${base}`
  if (prefixed.length <= 32) return prefixed
  const hash = createHash('sha256').update(displayName).digest('hex').slice(0, 8)
  return `${prefixed.slice(0, 23)}-${hash}`
}

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

function parseTranslations(value: unknown, serverName: string): CustomTranslations | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    throw new ConnectError('invalid_server_config', `${serverName}.x-dsh.translations 必须是对象`)
  }
  const out: CustomTranslations = {}
  for (const [locale, raw] of Object.entries(value)) {
    const label = `${serverName}.x-dsh.translations.${locale}`
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(locale)) {
      throw new ConnectError('invalid_server_config', `${label} 的语言代码不合法`)
    }
    if (!isRecord(raw)) {
      throw new ConnectError('invalid_server_config', `${label} 必须是对象`)
    }
    const description = optionalString(raw.description, `${label}.description`)
    if (description !== undefined && Array.from(description).length > 120) {
      throw new ConnectError('invalid_description', `${label}.description 最多 120 字`)
    }
    const category = optionalString(raw.category, `${label}.category`)
    if (category !== undefined && Array.from(category).length > 64) {
      throw new ConnectError('invalid_category', `${label}.category 最多 64 字`)
    }
    const rawExamples = stringArray(raw.examples, `${label}.examples`)
    let examples: string[] | undefined
    if (rawExamples !== undefined) {
      examples = rawExamples.map(item => item.trim()).filter(item => item !== '')
      if (examples.length > MAX_EXAMPLES) {
        throw new ConnectError('invalid_examples', `${label}.examples 最多 ${MAX_EXAMPLES} 条`)
      }
    }
    if (description !== undefined || category !== undefined || (examples !== undefined && examples.length > 0)) {
      out[locale] = {
        ...(description === undefined ? {} : { description }),
        ...(category === undefined ? {} : { category }),
        ...(examples === undefined || examples.length === 0 ? {} : { examples }),
      }
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

function parseXdsh(raw: Record<string, unknown>, serverName: string): { category?: string; description?: string; examples?: string[]; translations?: CustomTranslations } {
  const metadata = raw['x-dsh']
  if (metadata === undefined || metadata === null) return {}
  if (!isRecord(metadata)) {
    throw new ConnectError('invalid_server_config', `${serverName}.x-dsh 必须是对象`)
  }
  const category = optionalString(metadata.category, `${serverName}.x-dsh.category`)
  const description = optionalString(metadata.description, `${serverName}.x-dsh.description`)
  const rawExamples = stringArray(metadata.examples, `${serverName}.x-dsh.examples`)
  let examples: string[] | undefined
  if (rawExamples !== undefined) {
    examples = rawExamples.map(item => item.trim()).filter(item => item !== '')
    if (examples.length > MAX_EXAMPLES) {
      throw new ConnectError('invalid_examples', `${serverName}.x-dsh.examples 最多 ${MAX_EXAMPLES} 条`)
    }
  }
  const translations = parseTranslations(metadata.translations, serverName)
  return {
    ...(category === undefined ? {} : { category }),
    ...(description === undefined ? {} : { description }),
    ...(examples === undefined ? {} : { examples }),
    ...(translations === undefined ? {} : { translations }),
  }
}

function normalizeTransport(value: string, displayName: string): CustomTransport {
  const key = value.trim().toLowerCase()
  if (key === 'sse') return 'sse'
  if (key === 'http' || key === 'streamable-http' || key === 'streamablehttp') return 'streamable-http'
  if (key === 'stdio') return 'stdio'
  throw new ConnectError(
    'invalid_server_config',
    `${displayName} 的传输类型 "${value}" 不受支持，仅支持 sse / streamable-http / stdio`,
  )
}

function declaredTransport(raw: Record<string, unknown>, displayName: string): CustomTransport | undefined {
  const fromType = optionalString(raw.type, `${displayName}.type`)
  const fromTransport = optionalString(raw.transport, `${displayName}.transport`)
  const type = fromType === undefined ? undefined : normalizeTransport(fromType, displayName)
  const transport = fromTransport === undefined ? undefined : normalizeTransport(fromTransport, displayName)
  if (type !== undefined && transport !== undefined && type !== transport) {
    throw new ConnectError('invalid_server_config', `${displayName} 的 type 与 transport 不一致`)
  }
  return type ?? transport
}

function parseServer(displayName: string, raw: unknown): McpServerSeed {
  if (displayName.length > MAX_CONFIG_NAME_LENGTH || !CONFIG_NAME_RE.test(displayName)) {
    throw new ConnectError(
      'invalid_server_name',
      `serverName "${displayName}" 非法，只允许字母、数字、点、下划线、短横线，或 @scope/package 形式（最长 ${MAX_CONFIG_NAME_LENGTH} 字符）`,
    )
  }
  const serverName = toDshServerName(displayName)
  if (!isRecord(raw)) {
    throw new ConnectError('invalid_server_config', `${displayName} 的配置必须是对象`)
  }
  const metadata = parseXdsh(raw, displayName)

  const url = optionalString(raw.url, `${displayName}.url`)
  const command = optionalString(raw.command, `${displayName}.command`)
  if (url !== undefined && command !== undefined) {
    throw new ConnectError('invalid_server_config', `${displayName} 不能同时配置 url 与 command`)
  }
  if (url === undefined && command === undefined) {
    throw new ConnectError('invalid_server_config', `${displayName} 需要配置 url 或 command`)
  }
  const declared = declaredTransport(raw, displayName)

  if (url !== undefined) {
    if (declared === 'stdio') {
      throw new ConnectError('invalid_server_config', `${displayName} 配置了 url 时不能声明 stdio 传输`)
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
    } catch {
      throw new ConnectError('invalid_server_url', `${displayName} 的 url 必须是合法的 http(s) 地址`)
    }
    const headers = stringRecord(raw.headers, `${displayName}.headers`)
    return {
      serverName,
      displayName,
      connectorId: `custom-${serverName}`,
      transport: declared === 'sse' ? 'sse' : 'streamable-http',
      url,
      ...(headers === undefined ? {} : { headers }),
      ...(metadata.category === undefined ? {} : { category: metadata.category }),
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      ...(metadata.examples === undefined ? {} : { examples: metadata.examples }),
      ...(metadata.translations === undefined ? {} : { translations: metadata.translations }),
    }
  }

  if (command === undefined) {
    throw new ConnectError('invalid_server_config', `${displayName} 需要配置 command`)
  }
  if (declared !== undefined && declared !== 'stdio') {
    throw new ConnectError('invalid_server_config', `${displayName} 配置了 command 时只能声明 stdio 传输`)
  }
  const args = stringArray(raw.args, `${displayName}.args`)
  const env = stringRecord(raw.env, `${displayName}.env`)
  const cwd = optionalString(raw.cwd, `${displayName}.cwd`)
  return {
    serverName,
    displayName,
    connectorId: `custom-${serverName}`,
    transport: 'stdio',
    command,
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(metadata.category === undefined ? {} : { category: metadata.category }),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.examples === undefined ? {} : { examples: metadata.examples }),
    ...(metadata.translations === undefined ? {} : { translations: metadata.translations }),
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
  const seeds = entries.map(([serverName, raw]) => parseServer(serverName, raw))
  const seen = new Map<string, string>()
  for (const seed of seeds) {
    const previous = seen.get(seed.serverName)
    if (previous !== undefined) {
      throw new ConnectError(
        'server_name_conflict',
        `serverName "${seed.displayName}" 与 "${previous}" 映射到同一内部名称 "${seed.serverName}"，请修改其中一个`,
      )
    }
    seen.set(seed.serverName, seed.displayName)
  }
  return seeds
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
