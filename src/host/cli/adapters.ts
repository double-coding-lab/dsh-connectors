import type { CliCapabilitiesView } from '../../shared/types.js'

import { resolveNpmCommand, resolveNpxCommand } from './exec.js'

export type CliConnectorId = 'dingtalk' | 'feishu'

export interface CliAuthStatus {
  authenticated: boolean
  account?: {
    name?: string
    email?: string
    org?: string
  }
}

export interface CliLoginHint {
  link?: string
  code?: string
}

export interface CliCommand {
  command: string
  args: string[]
}

export interface CliInstallStep {
  label: string
  command: string
  args: string[]
}

export interface CliCapabilitySpec {
  args: string[]
  parse(raw: string): CliCapabilitiesView
}

export interface CliAdapter {
  id: CliConnectorId
  name: string
  vendor: string
  description: string
  category: string
  examples: string[]
  docsUrl: string
  bin: string
  versionArgs: string[]
  capabilities?: CliCapabilitySpec
  unsetEnv?: string[]
  install: CliInstallStep[]
  uninstall: CliInstallStep[]
  skills: {
    expectedPrefix: string
    expected: string[]
  }
  auth: {
    prepare?: CliCommand
    login: CliCommand
    status: CliCommand
    logout: CliCommand
  }
  parseStatus(raw: string): CliAuthStatus
  parseLoginHint(raw: string): CliLoginHint
}

const URL_PATTERN = /https?:\/\/[^\s"'<>）)】]+/i
const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)\b/g

function firstUrl(raw: string): string | undefined {
  const match = URL_PATTERN.exec(raw)
  return match?.[0]
}

function textStatus(raw: string): CliAuthStatus {
  const trimmed = raw.trim()
  if (trimmed === '') return { authenticated: false }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const pick = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
      return undefined
    }
    const identities = parsed.identities
    if (typeof identities === 'object' && identities !== null) {
      const user = (identities as Record<string, unknown>).user
      if (typeof user === 'object' && user !== null) {
        const record = user as Record<string, unknown>
        const ready = record.status === 'ready'
          || record.available === true
          || record.tokenStatus === 'valid'
          || record.authenticated === true
        if (ready) {
          const read = (...keys: string[]): string | undefined => {
            for (const key of keys) {
              const value = record[key]
              if (typeof value === 'string' && value.trim() !== '') return value.trim()
            }
            return undefined
          }
          const name = read('userName', 'user_name', 'nickName', 'nick_name', 'name')
          const email = read('email', 'mail')
          const org = read('tenantName', 'tenant_name', 'corpName', 'corp_name', 'org', 'orgName', 'org_name')
          return {
            authenticated: true,
            account: {
              ...(name === undefined ? {} : { name }),
              ...(email === undefined ? {} : { email }),
              ...(org === undefined ? {} : { org }),
            },
          }
        }
        if (record.status === 'expired' || record.status === 'invalid' || record.available === false) {
          return { authenticated: false }
        }
      }
    }

    const flag = parsed.authenticated ?? parsed.loggedIn ?? parsed.logged_in ?? parsed.isLogin ?? parsed.is_login
    const authenticated = flag === true || flag === 'true' || flag === 1
      || (typeof flag === 'undefined'
        && pick('userName', 'user_name', 'nickName', 'nick_name', 'email', 'userId', 'user_id', 'unionId') !== undefined)
    const accountName = pick('userName', 'user_name', 'nickName', 'nick_name', 'nick', 'name')
    const accountEmail = pick('email', 'mail')
    const accountOrg = pick('corpName', 'corp_name', 'orgName', 'org_name', 'tenantName', 'tenant_name', 'teamName', 'team_name')
    return {
      authenticated,
      ...(authenticated
        ? {
            account: {
              ...(accountName === undefined ? {} : { name: accountName }),
              ...(accountEmail === undefined ? {} : { email: accountEmail }),
              ...(accountOrg === undefined ? {} : { org: accountOrg }),
            },
          }
        : {}),
    }
  } catch {
    const negative = /(未登录|not logged|logged out|no account|not login|未授权|unauthenticated)/i.test(trimmed)
    if (negative) return { authenticated: false }
    const positive = /(已登录|logged in|login success|已授权|authenticated)/i.test(trimmed)
    if (!positive) return { authenticated: false }
    const name = /(?:用户|账号|account|user|name)[：:\s]+([^\s,，;；]+)/i.exec(trimmed)?.[1]
    const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(trimmed)?.[0]
    return { authenticated: true, account: { ...(name === undefined ? {} : { name }), ...(email === undefined ? {} : { email }) } }
  }
}

function textLoginHint(raw: string): CliLoginHint {
  const link = firstUrl(raw)
  if (link !== undefined) return { link }
  const codes = [...raw.matchAll(DEVICE_CODE_PATTERN)]
    .map(match => match[1])
    .filter((code): code is string => code !== undefined && !/^(HTTP|HTTPS|JSON|TRUE|FALSE)$/i.test(code))
  const code = codes[codes.length - 1]
  return code === undefined ? {} : { code }
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // try next candidate
    }
  }
  return undefined
}

function parseDwsCapabilities(raw: string): CliCapabilitiesView {
  const parsed = parseJsonObject(raw)
  const products = Array.isArray(parsed?.products) ? parsed.products : []
  const items = products.flatMap(product => {
    if (typeof product !== 'object' || product === null) return []
    const record = product as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.trim() === '') return []
    return [{
      id: record.id.trim(),
      name: record.id.trim(),
      ...(typeof record.agent_summary === 'string' && record.agent_summary.trim() !== ''
        ? { description: record.agent_summary.trim() }
        : {}),
      ...(typeof record.tool_count === 'number' ? { count: record.tool_count } : {}),
    }]
  })
  const metadata = parsed?.agent_metadata
  const surfaceTools = typeof metadata === 'object' && metadata !== null
    ? (metadata as Record<string, unknown>).surface_tools
    : undefined
  const total = typeof surfaceTools === 'number'
    ? surfaceTools
    : items.reduce((sum, item) => sum + (item.count ?? 0), 0)
  return { kind: 'products', total, items }
}

function parseLarkCapabilities(raw: string): CliCapabilitiesView {
  const parsed = parseJsonObject(raw)
  const skills = Array.isArray(parsed?.skills) ? parsed.skills : []
  const items = skills.flatMap(skill => {
    if (typeof skill !== 'object' || skill === null) return []
    const record = skill as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name.trim() === '') return []
    return [{
      id: record.name.trim(),
      name: record.name.trim(),
      ...(typeof record.description === 'string' && record.description.trim() !== ''
        ? { description: record.description.trim() }
        : {}),
    }]
  })
  return { kind: 'skills', total: items.length, items }
}

export const CLI_ADAPTERS: Record<CliConnectorId, CliAdapter> = {
  dingtalk: {
    id: 'dingtalk',
    name: '钉钉',
    vendor: '钉钉',
    description: '通过官方 dws CLI 管理钉钉全产品能力：AI 表格、考勤、日历、群聊与机器人、通讯录、DING、文档、云盘、AI 听记、邮箱、OA 审批、日志、待办。',
    category: '办公协作',
    examples: [
      '在钉钉群【产品周会】里用机器人发通知：今天 15:00 在 3 楼会议室开周会，带上上周进展材料',
      '查我下周的钉钉日程，列出与【客户对接】相关的会议，并找出三人都空闲的时段约同步会',
      '在钉钉 AI 表格【任务跟踪】新增一行：标题=Q2 上线评审、负责人=张三、截止=2026-05-20、状态=进行中',
      '用 dws 搜索我钉钉邮箱里最近一周来自财务部、主题含【报销】的邮件',
    ],
    docsUrl: 'https://open.dingtalk.com/document/development/dingtalk-dws-cli-install-guide',
    bin: 'dws',
    versionArgs: ['--version'],
    capabilities: { args: ['schema', '-f', 'json'], parse: parseDwsCapabilities },
    install: [
      { label: '安装 dws CLI', command: resolveNpmCommand(), args: ['install', '-g', 'dingtalk-workspace-cli'] },
    ],
    uninstall: [
      { label: '卸载 dws CLI', command: resolveNpmCommand(), args: ['uninstall', '-g', 'dingtalk-workspace-cli'] },
    ],
    skills: {
      expectedPrefix: 'dingtalk-',
      expected: ['dingtalk-aitable', 'dingtalk-calendar', 'dingtalk-chat', 'dingtalk-contact', 'dingtalk-doc', 'dingtalk-drive', 'dingtalk-todo', 'dingtalk-wiki'],
    },
    auth: {
      login: { command: 'dws', args: ['auth', 'login', '--device', '--recommend'] },
      status: { command: 'dws', args: ['auth', 'status', '--format', 'json'] },
      logout: { command: 'dws', args: ['auth', 'logout'] },
    },
    parseStatus: textStatus,
    parseLoginHint: textLoginHint,
  },
  feishu: {
    id: 'feishu',
    name: '飞书',
    vendor: '飞书',
    description: '通过官方 lark-cli 管理飞书：消息、文档、多维表格、电子表格、幻灯片、日历、邮箱、任务、会议等。',
    category: '办公协作',
    examples: [
      '在飞书群里发一条消息，汇总本周项目进展并 @ 相关负责人',
      '查我下周的飞书日历，列出与【客户对接】相关的会议并找出空闲时段',
      '在飞书多维表格【任务跟踪】新增一条记录：标题=Q2 上线评审、负责人=张三、截止=2026-05-20',
      '搜索我飞书邮箱里最近一周来自财务部、主题含【报销】的邮件',
    ],
    docsUrl: 'https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu',
    bin: 'lark-cli',
    versionArgs: ['--version'],
    capabilities: { args: ['skills', 'list'], parse: parseLarkCapabilities },
    unsetEnv: ['HERMES_HOME', 'OPENCLAW_HOME'],
    install: [
      { label: '安装 lark-cli', command: resolveNpmCommand(), args: ['install', '-g', '@larksuite/cli'] },
      { label: '安装飞书 Skills', command: resolveNpxCommand(), args: ['skills', 'add', 'larksuite/cli', '-y', '-g'] },
    ],
    uninstall: [
      { label: '卸载 lark-cli', command: resolveNpmCommand(), args: ['uninstall', '-g', '@larksuite/cli'] },
    ],
    skills: {
      expectedPrefix: 'lark-',
      expected: ['lark-shared', 'lark-calendar', 'lark-im', 'lark-doc', 'lark-drive', 'lark-sheets', 'lark-base', 'lark-task', 'lark-mail', 'lark-contact', 'lark-wiki'],
    },
    auth: {
      prepare: { command: 'lark-cli', args: ['config', 'init', '--new'] },
      login: { command: 'lark-cli', args: ['auth', 'login', '--recommend'] },
      status: { command: 'lark-cli', args: ['auth', 'status'] },
      logout: { command: 'lark-cli', args: ['auth', 'logout'] },
    },
    parseStatus: textStatus,
    parseLoginHint: textLoginHint,
  },
}

export function getAdapter(id: string): CliAdapter | undefined {
  return (CLI_ADAPTERS as Record<string, CliAdapter | undefined>)[id]
}

export function listAdapters(): CliAdapter[] {
  return Object.values(CLI_ADAPTERS)
}