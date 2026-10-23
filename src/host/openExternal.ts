import { execFile } from 'node:child_process'

export function openExternal(url: string): Promise<boolean> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return Promise.resolve(false)
  }
  if (target.protocol !== 'https:') return Promise.resolve(false)

  let command: string
  let args: string[]
  if (process.platform === 'win32') {
    command = 'rundll32.exe'
    args = ['url.dll,FileProtocolHandler', url]
  } else if (process.platform === 'darwin') {
    command = 'open'
    args = [url]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  return new Promise(resolve => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = execFile(command, args, { windowsHide: true }, () => undefined)
      child.once('spawn', () => finish(true))
      child.once('error', () => finish(false))
    } catch {
      finish(false)
    }
    setTimeout(() => finish(false), 3000).unref()
  })
}
