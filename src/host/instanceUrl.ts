import { ConnectError } from './errors.js'

export const INSTANCE_MCP_PATH = '/api/v4/mcp'

export interface ResolvedInstance {
  instanceUrl: string
  mcpUrl: string
}

function invalid(message: string): ConnectError {
  return new ConnectError('invalid_instance_url', message)
}

export function resolveInstanceMcpUrl(raw: string): ResolvedInstance {
  const value = raw.trim()
  if (value === '') throw invalid('请填写 GitLab 实例地址')

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalid('实例地址格式不正确，请填写包含 http:// 或 https:// 的完整地址')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('实例地址只支持 http:// 或 https://')
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid('实例地址不能包含账号或密码')
  }
  if (url.search !== '' || url.hash !== '') {
    throw invalid('实例地址不能包含查询参数或锚点')
  }

  let path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith(INSTANCE_MCP_PATH)) {
    path = path.slice(0, -INSTANCE_MCP_PATH.length).replace(/\/+$/, '')
  }
  const instanceUrl = `${url.origin}${path}`
  return {
    instanceUrl,
    mcpUrl: `${instanceUrl}${INSTANCE_MCP_PATH}`,
  }
}
