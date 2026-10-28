import { ConnectError } from './errors.js'

function invalid(message: string): ConnectError {
  return new ConnectError('invalid_instance_url', message)
}

export function resolveInstanceUrl(raw: string): string {
  const value = raw.trim()
  if (value === '') throw invalid('请填写服务地址')

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalid('地址格式不正确，请填写包含 http:// 或 https:// 的完整地址')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('服务地址只支持 http:// 或 https://')
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid('服务地址不能包含账号或密码')
  }
  if (url.hash !== '') {
    throw invalid('服务地址不能包含锚点')
  }

  return url.href
}
