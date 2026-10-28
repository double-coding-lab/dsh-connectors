import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
}

export interface ExecOptions {
  timeoutMs?: number
  maxBytes?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  acceptFailure?: boolean
}

export type ExecFn = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 64 * 1024

function needsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
}

function appendTail(current: string, chunk: Buffer, maxBytes: number): string {
  const next = current + chunk.toString('utf8')
  if (Buffer.byteLength(next) <= maxBytes) return next
  return next.slice(-maxBytes)
}

export const defaultExec: ExecFn = (command, args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  return new Promise<ExecResult>(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        shell: needsShell(command),
        windowsHide: true,
        cwd: options.cwd,
        env: options.env ?? process.env,
      })
    } catch (error) {
      resolve({ stdout: '', stderr: error instanceof Error ? error.message : String(error), code: null, timedOut: false })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk, maxBytes)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk, maxBytes)
    })
    child.on('error', error => {
      stderr = appendTail(stderr, Buffer.from(error.message), maxBytes)
      finish(null)
    })
    child.on('close', code => finish(code))
  })
}

export function resolveNpmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function resolveNpxCommand(): string {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx'
}

export interface StreamHandle {
  child: ReturnType<typeof spawn>
  done: Promise<ExecResult>
}

export function spawnStreaming(
  command: string,
  args: string[],
  options: ExecOptions & { onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void },
): StreamHandle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  let stdout = ''
  let stderr = ''
  let settled = false
  let timedOut = false

  const child = spawn(command, args, {
    shell: needsShell(command),
    windowsHide: true,
    cwd: options.cwd,
    env: options.env ?? process.env,
  })

  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)

  const done = new Promise<ExecResult>(resolve => {
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk, maxBytes)
      options.onOutput?.({ stream: 'stdout', text: chunk.toString('utf8') })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk, maxBytes)
      options.onOutput?.({ stream: 'stderr', text: chunk.toString('utf8') })
    })
    child.on('error', error => {
      stderr = appendTail(stderr, Buffer.from(error.message), maxBytes)
      options.onOutput?.({ stream: 'stderr', text: error.message })
      finish(null)
    })
    child.on('close', code => finish(code))
  })

  return { child, done }
}

export async function resolveBinary(name: string, exec: ExecFn = defaultExec): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  const result = await exec(locator, [name], { timeoutMs: 8_000, acceptFailure: true })
  const lines = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  if (process.platform === 'win32') {
    const preferred = lines.find(line => /\.(exe|cmd)$/i.test(line))
    if (preferred !== undefined) return preferred
    for (const line of lines) {
      for (const ext of ['.cmd', '.exe']) {
        if (existsSync(`${line}${ext}`)) return `${line}${ext}`
      }
    }
  }
  if (lines[0] !== undefined) return lines[0]

  const home = homedir()
  const candidates = process.platform === 'win32'
    ? [
        join(home, '.local', 'bin', `${name}.exe`),
        join(home, '.local', 'bin', name),
        join(home, 'AppData', 'Roaming', 'npm', `${name}.cmd`),
        join(home, 'AppData', 'Roaming', 'npm', `${name}.exe`),
        join(home, 'AppData', 'Local', 'Programs', name, `${name}.exe`),
        join(home, '.dws', 'bin', `${name}.exe`),
      ]
    : [
        join(home, '.local', 'bin', name),
        join(home, '.npm-global', 'bin', name),
      ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(access_token|refresh_token|id_token|client_secret|api_key|apikey|token|secret)\s*[:=]\s*([^&\s"']{4,})/gi,
  /(Authorization|X-Auth-Token|X-Lark-MCP-UAT|X-Lark-MCP-TAT)\s*[:=]\s*\S+/gi,
]

export function redactOutput(text: string): string {
  let next = text
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, match => {
      const equals = match.indexOf('=')
      if (equals >= 0 && !match.toLowerCase().startsWith('bearer')) {
        return `${match.slice(0, equals)}=***`
      }
      const colon = match.indexOf(':')
      if (colon >= 0 && !match.toLowerCase().startsWith('bearer')) {
        return `${match.slice(0, colon)}: ***`
      }
      return '***'
    })
  }
  return next
}