import { existsSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Domain } from '@deepseek-ai/dsh-storage-domain'

import type { CliCapabilitiesView, CliConnectorId, CliConnectorView, CliPhase } from '../../shared/types.js'
import { ConnectError } from '../errors.js'
import { openExternal } from '../openExternal.js'
import { defineCliDomain, type CliConnectorRecord } from '../store.js'
import { getAdapter, listAdapters, type CliAdapter } from './adapters.js'
import { defaultExec, redactOutput, resolveBinary, spawnStreaming, type ExecFn } from './exec.js'

const VERSION_TIMEOUT_MS = 10_000
const STATUS_TIMEOUT_MS = 15_000
const CAPABILITY_TIMEOUT_MS = 20_000
const CAPABILITY_TTL_MS = 10 * 60 * 1000
const INSTALL_TIMEOUT_MS = 600_000
const PREPARE_TIMEOUT_MS = 300_000
const LOGIN_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 128 * 1024

interface StorageDomainFace {
  open: (spec: ReturnType<typeof defineCliDomain>) => Promise<Domain<ReturnType<typeof defineCliDomain>>>
}

export interface CliServiceContext {
  storageDomain?: StorageDomainFace
}

interface CliJob {
  connectorId: CliConnectorId
  kind: 'install' | 'login' | 'uninstall'
  phase: CliPhase
  stage: string
  link?: string
  code?: string
  output: string
  error?: string
  child?: { kill: () => boolean }
  cancel: boolean
  done: boolean
  settled: boolean
}

function skillDirs(): string[] {
  return [join(homedir(), '.agents', 'skills'), join(homedir(), '.dsh', 'skills')]
}

function trimOutput(current: string, chunk: string): string {
  const next = current + chunk
  return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next
}

function versionLine(raw: string): string | undefined {
  const line = raw
    .split(/\r?\n/)
    .map(item => item.trim())
    .find(item => item !== '')
  if (line === undefined) return undefined
  const semver = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(line)?.[1]
  if (semver !== undefined) return semver
  return line.replace(/^v/i, '').slice(0, 32)
}

function installHint(adapter: CliAdapter): string[] {
  return adapter.install.map(step => [step.command, ...step.args].join(' ').replace(/\.cmd\b/gi, ''))
}

function commandEnv(adapter: CliAdapter): NodeJS.ProcessEnv | undefined {
  if (adapter.unsetEnv === undefined || adapter.unsetEnv.length === 0) return undefined
  const env = { ...process.env }
  for (const key of adapter.unsetEnv) delete env[key]
  return env
}

export class CliConnectorService {
  private readonly domainPromise: Promise<Domain<ReturnType<typeof defineCliDomain>>>
  private readonly jobs = new Map<string, CliJob>()
  private readonly cache = new Map<string, CliConnectorView>()
  private readonly capabilityCache = new Map<string, { at: number; value?: CliCapabilitiesView }>()

  constructor(
    private readonly ctx: CliServiceContext,
    private readonly exec: ExecFn = defaultExec,
  ) {
    if (ctx.storageDomain === undefined) throw new Error('storageDomain service is unavailable')
    this.domainPromise = ctx.storageDomain.open(defineCliDomain())
  }

  private async table() {
    const domain = await this.domainPromise
    return domain.table('cli_connectors')
  }

  async dispose(): Promise<void> {
    for (const job of this.jobs.values()) job.child?.kill()
    const domain = await this.domainPromise
    await domain.close()
  }

  private async remember(view: CliConnectorView): Promise<void> {
    const table = await this.table()
    const previous = table.get(view.id)
    const now = Date.now()
    const record: CliConnectorRecord = {
      key: view.id,
      connectorId: view.id,
      installed: view.installed,
      enabled: view.enabled,
      ...(view.version === undefined ? {} : { installedVersion: view.version }),
      authenticated: view.authenticated,
      ...(view.account === undefined ? {} : { account: view.account }),
      skillsCount: view.skills.count,
      ...(view.lastError === undefined ? {} : { lastError: view.lastError }),
      lastCheckedAt: now,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    await table.put(view.id, record)
  }

  private async capabilitiesFor(adapter: CliAdapter, binPath: string): Promise<CliCapabilitiesView | undefined> {
    if (adapter.capabilities === undefined) return undefined
    const cached = this.capabilityCache.get(adapter.id)
    if (cached !== undefined && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.value

    const env = commandEnv(adapter)
    const result = await this.exec(binPath, adapter.capabilities.args, {
      timeoutMs: CAPABILITY_TIMEOUT_MS,
      acceptFailure: true,
      ...(env === undefined ? {} : { env }),
    })
    let value: CliCapabilitiesView | undefined
    if (result.code === 0) {
      try {
        const parsed = adapter.capabilities.parse(result.stdout || result.stderr)
        if (parsed.items.length > 0) value = parsed
      } catch {
        // 能力目录解析失败不影响连接状态
      }
    }
    this.capabilityCache.set(adapter.id, { at: Date.now(), value: value ?? cached?.value })
    return value ?? cached?.value
  }

  private baseView(adapter: CliAdapter, record?: CliConnectorRecord): CliConnectorView {
    const installed = record?.installed === true || record?.installedVersion !== undefined
    return {
      id: adapter.id,
      name: adapter.name,
      vendor: adapter.vendor,
      description: adapter.description,
      category: adapter.category,
      docsUrl: adapter.docsUrl,
      examples: adapter.examples,
      installHint: installHint(adapter),
      installed,
      enabled: record?.enabled !== false,
      ...(record?.installedVersion === undefined ? {} : { version: record.installedVersion }),
      authenticated: record?.authenticated === true,
      ...(record?.account === undefined ? {} : { account: record.account }),
      skills: { installed: (record?.skillsCount ?? 0) > 0, count: record?.skillsCount ?? 0, names: [] },
      phase: record?.lastError === undefined ? 'idle' : 'error',
      ...(record?.lastError === undefined ? {} : { lastError: record.lastError }),
      ...(record?.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
    }
  }

  private scanSkills(adapter: CliAdapter): CliConnectorView['skills'] {
    const names: string[] = []
    let dir: string | undefined
    for (const root of skillDirs()) {
      if (!existsSync(root)) continue
      let entries: Dirent[]
      try {
        entries = readdirSync(root, { withFileTypes: true }) as Dirent[]
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith(adapter.skills.expectedPrefix)) continue
        if (!existsSync(join(root, entry.name, 'SKILL.md'))) continue
        if (!names.includes(entry.name)) names.push(entry.name)
      }
      if (dir === undefined && names.length > 0) dir = root
    }
    names.sort((left, right) => left.localeCompare(right, 'zh-CN'))
    return { installed: names.length > 0, count: names.length, names, ...(dir === undefined ? {} : { dir }) }
  }

  private removeSkills(adapter: CliAdapter): number {
    let removed = 0
    for (const root of skillDirs()) {
      if (!existsSync(root)) continue
      let entries: Dirent[]
      try {
        entries = readdirSync(root, { withFileTypes: true }) as Dirent[]
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith(adapter.skills.expectedPrefix)) continue
        const dir = join(root, entry.name)
        if (!existsSync(join(dir, 'SKILL.md'))) continue
        try {
          rmSync(dir, { recursive: true, force: true })
          removed += 1
        } catch {
          // 单个 Skills 删除失败不阻断其余清理
        }
      }
    }
    return removed
  }

  private mergeJob(view: CliConnectorView): CliConnectorView {
    const job = this.jobs.get(view.id)
    if (job === undefined) return view
    const output = job.output === '' ? {} : { output: redactOutput(job.output.slice(-8000)) }
    if (job.done) {
      const staleLoginError = job.kind === 'login' && view.authenticated && job.error !== undefined
      if (job.error !== undefined && !staleLoginError) {
        return { ...view, ...output, lastError: job.error, phase: 'error' as CliPhase }
      }
      if (!job.settled && !job.cancel) {
        return { ...view, ...output, phase: job.phase, stage: job.stage }
      }
      return { ...view, ...output }
    }
    return {
      ...view,
      phase: job.phase,
      stage: job.stage,
      ...output,
      ...(job.link === undefined ? {} : { link: job.link }),
      ...(job.code === undefined ? {} : { code: job.code }),
      ...(job.error === undefined ? {} : { lastError: job.error }),
    }
  }

  async list(): Promise<CliConnectorView[]> {
    const table = await this.table()
    return listAdapters().map(adapter => {
      const cached = this.cache.get(adapter.id) ?? this.baseView(adapter, table.get(adapter.id))
      return this.mergeJob(cached)
    })
  }

  async view(id: string): Promise<CliConnectorView> {
    const adapter = getAdapter(id)
    if (adapter === undefined) throw new ConnectError('not_found', '未知的 CLI 连接器')
    const table = await this.table()
    return this.mergeJob(this.cache.get(adapter.id) ?? this.baseView(adapter, table.get(adapter.id)))
  }

  async setEnabled(id: string, enabled: boolean): Promise<CliConnectorView> {
    const adapter = getAdapter(id)
    if (adapter === undefined) throw new ConnectError('not_found', '未知的 CLI 连接器')
    this.assertIdle(adapter.id)
    const current = this.cache.get(adapter.id) ?? await this.refresh(adapter.id)
    const view: CliConnectorView = { ...current, enabled, updatedAt: Date.now() }
    this.cache.set(adapter.id, view)
    await this.remember(view)
    return view
  }

  async refresh(id: string): Promise<CliConnectorView> {
    const adapter = getAdapter(id)
    if (adapter === undefined) throw new ConnectError('not_found', '未知的 CLI 连接器')
    const running = this.jobs.get(adapter.id)
    if (running !== undefined && !running.done) return this.view(adapter.id)

    const table = await this.table()
    const previous = table.get(adapter.id)
    const skills = this.scanSkills(adapter)
    const binPath = await resolveBinary(adapter.bin, this.exec)
    if (binPath === null) {
      const view: CliConnectorView = {
        id: adapter.id,
        name: adapter.name,
        vendor: adapter.vendor,
        description: adapter.description,
        category: adapter.category,
        docsUrl: adapter.docsUrl,
        examples: adapter.examples,
        installHint: installHint(adapter),
        installed: false,
        enabled: previous?.enabled !== false,
        authenticated: false,
        skills,
        phase: 'idle',
        updatedAt: Date.now(),
      }
      this.cache.set(adapter.id, view)
      await this.remember(view)
      return view
    }

    const env = commandEnv(adapter)
    const [versionResult, statusResult, capabilities] = await Promise.all([
      this.exec(binPath, adapter.versionArgs, {
        timeoutMs: VERSION_TIMEOUT_MS,
        acceptFailure: true,
        ...(env === undefined ? {} : { env }),
      }),
      this.exec(binPath, adapter.auth.status.args, {
        timeoutMs: STATUS_TIMEOUT_MS,
        acceptFailure: true,
        ...(env === undefined ? {} : { env }),
      }),
      this.capabilitiesFor(adapter, binPath),
    ])
    const rawStatus = `${statusResult.stdout}\n${statusResult.stderr}`
    const parsed = adapter.parseStatus(rawStatus)
    const authenticated = statusResult.timedOut ? previous?.authenticated === true : parsed.authenticated
    if (authenticated) {
      const job = this.jobs.get(adapter.id)
      if (job !== undefined && job.kind === 'login') {
        job.error = undefined
        if (job.phase === 'error') job.phase = 'idle'
      }
    }
    const versionOk = versionResult.code === 0 && !versionResult.timedOut
    const version = versionLine(`${versionResult.stdout}\n${versionResult.stderr}`)
      ?? (versionOk ? versionLine(previous?.installedVersion ?? '') : undefined)
    const error = statusResult.timedOut
      ? '获取登录状态超时'
      : !versionOk
        ? 'CLI 无法执行，请重新安装或查看官方文档'
        : undefined

    const view: CliConnectorView = {
      id: adapter.id,
      name: adapter.name,
      vendor: adapter.vendor,
      description: adapter.description,
      category: adapter.category,
      docsUrl: adapter.docsUrl,
      examples: adapter.examples,
      installHint: installHint(adapter),
      installed: true,
      enabled: previous?.enabled !== false,
      ...(version === undefined ? {} : { version }),
      authenticated,
      ...(parsed.account === undefined ? {} : { account: parsed.account }),
      skills,
      ...(capabilities === undefined ? {} : { capabilities }),
      phase: error === undefined ? 'idle' : 'error',
      ...(error === undefined ? {} : { lastError: error }),
      updatedAt: Date.now(),
    }
    this.cache.set(adapter.id, view)
    await this.remember(view)
    return view
  }

  async detectAll(): Promise<void> {
    await Promise.all(listAdapters().map(adapter => this.refresh(adapter.id).catch(() => undefined)))
  }

  async startInstall(id: string): Promise<CliConnectorView> {
    const adapter = getAdapter(id)
    if (adapter === undefined) throw new ConnectError('not_found', '未知的 CLI 连接器')
    this.assertIdle(adapter.id)
    const job: CliJob = {
      connectorId: adapter.id,
      kind: 'install',
      phase: 'installing',
      stage: adapter.install[0]?.label ?? '安装 CLI',
      output: '',
      cancel: false,
      done: false,
      settled: false,
    }
    this.jobs.set(adapter.id, job)
    void (async () => {
      const env = commandEnv(adapter)
      try {
        for (const step of adapter.install) {
          if (job.cancel) return
          job.stage = step.label
          const handle = spawnStreaming(step.command, step.args, {
            timeoutMs: INSTALL_TIMEOUT_MS,
            onOutput: chunk => {
              job.output = trimOutput(job.output, chunk.text)
            },
            ...(env === undefined ? {} : { env }),
          })
          job.child = handle.child
          const result = await handle.done
          if (job.cancel) return
          if (result.code !== 0) {
            throw new Error(`${step.label}失败：${redactOutput(result.stderr || result.stdout).trim().slice(0, 300) || `退出码 ${String(result.code)}`}`)
          }
        }
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error)
        job.phase = 'error'
        return
      } finally {
        job.done = true
      }
      if (job.cancel) return
      this.capabilityCache.delete(adapter.id)
      await this.refresh(adapter.id).catch(() => undefined)
      job.settled = true
    })()
    return this.view(adapter.id)
  }

  async startLogin(id: string): Promise<CliConnectorView> {
    const adapter = getAdapter(id)
    if (adapter === undefined) throw new ConnectError('not_found', '未知的 CLI 连接器')
    this.assertIdle(adapter.id)
    const current = await this.view(adapter.id)
    if (!current.installed) throw new ConnectError('cli_not_installed', '请先安装 CLI')
    const binPath = await resolveBinary(adapter.bin, this.exec)
    if (binPath === null) throw new ConnectError('cli_not_installed', 'CLI 可执行文件未找到，请重新安装')
    const job: CliJob = {
      connectorId: adapter.id,
      kind: 'login',
      phase: adapter.auth.prepare === undefined ? 'logging_in' : 'configuring',
      stage: adapter.auth.prepare === undefined ? '登录' : '配置应用',
      output: '',
      cancel: false,
      done: false,
      settled: false,
    }
    this.jobs.set(adapter.id, job)
    void (async () => {
      try {
        if (adapter.auth.prepare !== undefined) {
          const prepared = await this.runLoginCommand(job, adapter, binPath, adapter.auth.prepare.args, PREPARE_TIMEOUT_MS)
          if (job.cancel) return
          if (prepared.code !== 0) throw new Error(`配置失败：${this.tail(prepared.stderr || prepared.stdout)}`)
          job.link = undefined
          job.code = undefined
        }
        job.phase = 'logging_in'
        job.stage = '登录'
        const logged = await this.runLoginCommand(job, adapter, binPath, adapter.auth.login.args, LOGIN_TIMEOUT_MS)
        if (job.cancel) return
        const view = await this.refresh(adapter.id).catch(() => undefined)
        if (view?.authenticated === true) {
          job.link = undefined
          job.code = undefined
          return
        }
        if (logged.code !== 0) throw new Error(`登录失败：${this.tail(logged.stderr || logged.stdout)}`)
        throw new Error('登录未完成：请确认已在浏览器完成授权后重试')
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error)
        job.phase = 'error'
      } finally {
        job.done = true
      }
      if (!job.cancel) await this.refresh(adapter.id).catch(() => undefined)
      job.settled = true
    })()
    return this.view(adapter.id)
  }

  private async runLoginCommand(
    job: CliJob,
    adapter: CliAdapter,
    binPath: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const env = commandEnv(adapter)
    const capture = (text: string): void => {
      const hint = adapter.parseLoginHint(text)
      if (job.link === undefined && hint.link !== undefined) {
        job.link = hint.link
        void openExternal(job.link)
      }
      if (job.code === undefined && hint.code !== undefined) job.code = hint.code
    }
    const handle = spawnStreaming(binPath, args, {
      timeoutMs,
      onOutput: chunk => {
        job.output = trimOutput(job.output, chunk.text)
        capture(chunk.text)
      },
      ...(env === undefined ? {} : { env }),
    })
    job.child = handle.child
    const result = await handle.done
    if (result.timedOut) throw new Error('登录超时：请重新发起并在浏览器完成授权')
    capture(`${result.stdout}\n${result.stderr}`)
    return result
  }

  private tail(raw: string): string {
    return redactOutput(raw).trim().slice(-300) || 'CLI 未返回更多信息'
  }

  async logout(id: string): Promise<CliConnectorView> {
    const adapter = getAdapter(id)
    if (adapter === undefined) throw new ConnectError('not_found', '未知的 CLI 连接器')
    this.assertIdle(adapter.id)
    const binPath = await resolveBinary(adapter.bin, this.exec)
    if (binPath === null) throw new ConnectError('cli_not_installed', 'CLI 可执行文件未找到')
    const env = commandEnv(adapter)
    const result = await this.exec(binPath, adapter.auth.logout.args, {
      timeoutMs: STATUS_TIMEOUT_MS,
      acceptFailure: true,
      ...(env === undefined ? {} : { env }),
    })
    if (result.code !== 0) throw new ConnectError('cli_logout_failed', this.tail(result.stderr || result.stdout))
    this.jobs.delete(adapter.id)
    return this.refresh(adapter.id)
  }

  async startUninstall(id: string): Promise<CliConnectorView> {
    const adapter = getAdapter(id)
    if (adapter === undefined) throw new ConnectError('not_found', '未知的 CLI 连接器')
    this.assertIdle(adapter.id)
    const job: CliJob = {
      connectorId: adapter.id,
      kind: 'uninstall',
      phase: 'uninstalling',
      stage: '准备卸载',
      output: '',
      cancel: false,
      done: false,
      settled: false,
    }
    this.jobs.set(adapter.id, job)
    void (async () => {
      try {
        const binPath = await resolveBinary(adapter.bin, this.exec)
        if (binPath !== null) {
          job.stage = '退出登录'
          const env = commandEnv(adapter)
          await this.exec(binPath, adapter.auth.logout.args, {
            timeoutMs: STATUS_TIMEOUT_MS,
            acceptFailure: true,
            ...(env === undefined ? {} : { env }),
          }).catch(() => undefined)
          if (job.cancel) return
          for (const step of adapter.uninstall) {
            if (job.cancel) return
            job.stage = step.label
            const handle = spawnStreaming(step.command, step.args, {
              timeoutMs: INSTALL_TIMEOUT_MS,
              onOutput: chunk => {
                job.output = trimOutput(job.output, chunk.text)
              },
              ...(env === undefined ? {} : { env }),
            })
            job.child = handle.child
            const result = await handle.done
            if (job.cancel) return
            if (result.code !== 0) {
              throw new Error(`${step.label}失败：${this.tail(result.stderr || result.stdout)}`)
            }
          }
        }
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error)
        job.phase = 'error'
      } finally {
        job.done = true
      }
      if (job.cancel) {
        await this.refresh(adapter.id).catch(() => undefined)
        job.settled = true
        return
      }
      if (job.error !== undefined) {
        job.settled = true
        return
      }
      try {
        job.stage = '删除 Skills'
        this.removeSkills(adapter)
        this.capabilityCache.delete(adapter.id)
        this.cache.delete(adapter.id)
        const table = await this.table()
        await table.delete(adapter.id)
        job.stage = '完成'
        job.settled = true
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error)
        job.phase = 'error'
        job.settled = true
      }
    })()
    return this.view(adapter.id)
  }

  async cancel(id: string): Promise<CliConnectorView> {
    const adapter = getAdapter(id)
    if (adapter === undefined) throw new ConnectError('not_found', '未知的 CLI 连接器')
    const job = this.jobs.get(adapter.id)
    if (job === undefined || job.done) return this.view(adapter.id)
    job.cancel = true
    job.done = true
    job.settled = true
    job.child?.kill()
    if (job.kind === 'uninstall') return this.refresh(adapter.id).catch(() => this.view(adapter.id))
    return this.view(adapter.id)
  }

  log(id: string): string {
    const job = this.jobs.get(id)
    return job === undefined ? '' : redactOutput(job.output.slice(-8000))
  }

  private assertIdle(id: string): void {
    const job = this.jobs.get(id)
    if (job !== undefined && !job.done) throw new ConnectError('cli_busy', '当前连接器正在安装、登录或卸载，请稍候')
  }
}