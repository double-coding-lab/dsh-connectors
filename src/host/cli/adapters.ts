import { homedir } from 'node:os'
import { join } from 'node:path'

import type { CliCapabilitiesView } from '../../shared/types.js'

import { resolveNpmCommand, resolveNpxCommand } from './exec.js'

export type CliConnectorId = 'dingtalk' | 'feishu' | 'tmeet' | 'wecom' | 'hf' | 'agent-mail'

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
  /** 优先使用的可执行文件路径（例如 uv 装到 ~/.local/bin，而 PATH 上可能有旧版） */
  binCandidates?: string[]
  versionArgs: string[]
  /** 官方要求的最低版本；低于时界面提示更新 */
  minVersion?: string
  /** 登录等待上限，缺省 120s；个别 CLI 的设备码有效期更长 */
  loginTimeoutMs?: number
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
    logout?: CliCommand
  }
  /** CLI 没有 logout 子命令时，用删除本地凭据文件实现解绑 */
  logoutFiles?: {
    dir: string
    envDir?: string
    files: string[]
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
  const labelled = /(?:code|代码|设备码|verification)[^\w]{0,8}([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)/i.exec(raw)?.[1]
  const candidates = [...raw.matchAll(DEVICE_CODE_PATTERN)]
    .map(match => match[1])
    .filter((code): code is string => code !== undefined && !/^(HTTP|HTTPS|JSON|TRUE|FALSE)$/i.test(code))
  const code = labelled ?? candidates[candidates.length - 1]
  return {
    ...(link === undefined ? {} : { link }),
    ...(code === undefined ? {} : { code }),
  }
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

const TMEET_GROUPS: Record<string, string> = {
  app: '应用开通与授权配置',
  auth: '登录与授权状态',
  contact: '企业通讯录',
  control: '会中控制（成员、静音、共享）',
  event: '实时事件订阅',
  meeting: '会议预约、查询与邀请人',
  minutes: '智能纪要',
  record: '录制与转写',
  report: '会议报告',
  tshoot: '故障排查',
}

function parseTmeetCapabilities(raw: string): CliCapabilitiesView {
  const lines = raw.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === 'Available Commands:')
  const items: CliCapabilitiesView['items'] = []
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('Flags:')) break
      const match = /^([a-z][a-z0-9-]*)\s*(.*)$/.exec(trimmed)
      if (match === null) continue
      const id = match[1] as string
      const summary = (match[2] ?? '').trim()
      if (id === 'help' || id === 'completion') continue
      items.push({
        id,
        name: id,
        ...(TMEET_GROUPS[id] === undefined && summary === '' ? {} : { description: TMEET_GROUPS[id] ?? summary }),
      })
    }
  }
  return { kind: 'groups', total: items.length, items }
}


const WECOM_SKIP_COMMANDS = new Set(['auth', 'help'])

function parseWecomCapabilities(raw: string): CliCapabilitiesView {
  const lines = raw.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === 'Commands:')
  const items: CliCapabilitiesView['items'] = []
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('Options:')) break
      const match = /^([a-z][a-z0-9-]*)\s+(.+)$/.exec(trimmed)
      if (match === null) continue
      const id = match[1] as string
      if (WECOM_SKIP_COMMANDS.has(id)) continue
      items.push({ id, name: id, description: (match[2] as string).trim() })
    }
  }
  return { kind: 'groups', total: items.length, items }
}

function parseWecomStatus(raw: string): CliAuthStatus {
  const text = raw.trim()
  const lower = text.toLowerCase()
  if (!/status\s*:\s*authorized/.test(lower)) return { authenticated: false }
  const line = (pattern: RegExp): string | undefined => pattern.exec(text)?.[1]?.trim()
  // auth show 只给 Bot ID，没有机器人名称或用户名，不把 ID 当账号名展示
  const name = line(/(?:机器人名称|Bot\s*Name)[^\n:：]*[:：]\s*(\S+)/i)
  const org = line(/(?:企业名称|团队名称|Corp\s*Name)[^\n:：]*[:：]\s*([^\n]+)/i)
  return {
    authenticated: true,
    ...(name === undefined && org === undefined
      ? {}
      : { account: { ...(name === undefined ? {} : { name }), ...(org === undefined ? {} : { org }) } }),
  }
}


const HF_SKIP_COMMANDS = new Set(['auth', 'skills'])

function parseHfCapabilities(raw: string): CliCapabilitiesView {
  const lines = raw.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === 'Main commands:')
  const items: CliCapabilitiesView['items'] = []
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('Help commands:')) break
      const match = /^([a-z][a-z0-9-]*)\s{2,}(.+)$/.exec(trimmed)
      if (match === null) continue
      const id = match[1] as string
      if (HF_SKIP_COMMANDS.has(id)) continue
      items.push({ id, name: id, description: (match[2] as string).trim() })
    }
  }
  return { kind: 'groups', total: items.length, items }
}

function parseHfStatus(raw: string): CliAuthStatus {
  const text = raw.trim()
  if (/(not logged in|no token|invalid token|unauthorized)/i.test(text)) return { authenticated: false }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const read = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
        if (typeof value === 'object' && value !== null) {
          const nested = (value as Record<string, unknown>).name
          if (typeof nested === 'string' && nested.trim() !== '') return nested.trim()
        }
      }
      return undefined
    }
    const name = read('name', 'user', 'username', 'fullname')
    const email = read('email')
    const org = read('org', 'orgs', 'orgName')
    return {
      authenticated: true,
      ...(name === undefined && email === undefined && org === undefined
        ? {}
        : { account: { ...(name === undefined ? {} : { name }), ...(email === undefined ? {} : { email }), ...(org === undefined ? {} : { org }) } }),
    }
  } catch {
    const name = /(?:user(?:name)?|account)\s*[:：]\s*(\S+)/i.exec(text)?.[1]
    return { authenticated: text !== '', ...(name === undefined ? {} : { account: { name } }) }
  }
}

const HF_BIN = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'hf.exe' : 'hf')


const AGENT_MAIL_SKIP_COMMANDS = new Set(['auth', 'help'])

const AGENT_MAIL_GROUPS: Record<string, string> = {
  '+me': '当前账号与别名',
  attachment: '附件上传与下载',
  message: '邮件列表、读取、搜索、监听、发送、回复、转发、垃圾箱与删除',
}

function parseAgentMailCapabilities(raw: string): CliCapabilitiesView {
  const lines = raw.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === 'Available Commands:')
  const items: CliCapabilitiesView['items'] = []
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('Flags:')) break
      const match = /^(\+?[a-z][a-z0-9-]*)\s{2,}(.+)$/.exec(trimmed)
      if (match === null) continue
      const id = match[1] as string
      if (AGENT_MAIL_SKIP_COMMANDS.has(id)) continue
      items.push({ id: id.startsWith('+') ? id.slice(1) : id, name: id, description: AGENT_MAIL_GROUPS[id] ?? (match[2] as string).trim() })
    }
  }
  return { kind: 'groups', total: items.length, items }
}

function parseAgentMailStatus(raw: string): CliAuthStatus {
  const text = raw.trim()
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const data = typeof parsed.data === 'object' && parsed.data !== null
      ? parsed.data as Record<string, unknown>
      : parsed
    const loggedIn = data.logged_in === true || data.status === 'logged_in' || data.logged_in === 'true'
    if (!loggedIn) return { authenticated: false }
    const read = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = data[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
      return undefined
    }
    const name = read('email', 'mail', 'address', 'alias', 'user')
    return { authenticated: true, ...(name === undefined ? {} : { account: { name } }) }
  } catch {
    return { authenticated: /"logged_in"\s*:\s*true/.test(text) }
  }
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
  tmeet: {
    id: 'tmeet',
    name: '腾讯会议',
    vendor: '腾讯',
    description: '通过官方 tmeet CLI 管理腾讯会议：预约/查询会议、邀请人、录制与转写、智能纪要、会议报告、会中控制。',
    category: '办公协作',
    examples: [
      '帮我约下周三 15:00 的腾讯会议，主题【Q3 方案评审】，邀请张三和李四',
      '查我下周的腾讯会议，按时间列出来',
      '把昨天那场会的智能纪要整理成待办',
      '找上周那场会的录制链接和参会报告',
    ],
    docsUrl: 'https://meeting.tencent.com/support/topic/2236/index.html',
    bin: 'tmeet',
    versionArgs: ['--version'],
    capabilities: { args: ['--help'], parse: parseTmeetCapabilities },
    install: [
      { label: '安装 tmeet CLI', command: resolveNpmCommand(), args: ['install', '-g', '@tencentcloud/tmeet'] },
      { label: '安装腾讯会议 Skills', command: resolveNpxCommand(), args: ['skills', 'add', 'TencentCloud/tencentmeeting-cli', '-y', '-g'] },
    ],
    uninstall: [
      { label: '卸载 tmeet CLI', command: resolveNpmCommand(), args: ['uninstall', '-g', '@tencentcloud/tmeet'] },
    ],
    skills: {
      expectedPrefix: 'tmeet',
      expected: ['tmeet-skill'],
    },
    auth: {
      login: { command: 'tmeet', args: ['auth', 'login', '--no-browser'] },
      status: { command: 'tmeet', args: ['auth', 'status', '--format', 'json'] },
      logout: { command: 'tmeet', args: ['auth', 'logout'] },
    },
    parseStatus: textStatus,
    parseLoginHint: textLoginHint,
  },
  wecom: {
    id: 'wecom',
    name: '企业微信',
    vendor: '企业微信',
    description: '通过官方 wecom-cli 操作企业微信：消息、邮件、文档、表格、智能表格、智能文档、待办、日程、会议、微盘、通讯录。',
    category: '办公协作',
    examples: [
      '在企业微信里给张三发一条消息，说明今天的发布已推迟到 18 点',
      '搜一下我这周的邮件，把需要今天回复的列出来',
      '在智能表格【任务跟踪】新增一行：标题=Q3 复盘、负责人=张三、截止=2026-11-05',
      '查我明天的日程，把和客户相关的会议整理成一页待办',
    ],
    docsUrl: 'https://developer.work.weixin.qq.com/document/path/101750',
    bin: 'wecom-cli',
    versionArgs: ['--version'],
    minVersion: '1.2.1',
    capabilities: { args: ['--help'], parse: parseWecomCapabilities },
    install: [
      { label: '安装 wecom-cli', command: resolveNpmCommand(), args: ['install', '-g', '@wecom/cli'] },
      { label: '安装企业微信 Skills', command: resolveNpxCommand(), args: ['skills', 'add', 'WeComTeam/wecom-cli', '-y', '-g'] },
    ],
    uninstall: [
      { label: '卸载 wecom-cli', command: resolveNpmCommand(), args: ['uninstall', '-g', '@wecom/cli'] },
    ],
    skills: {
      expectedPrefix: 'wecomcli',
      expected: ['wecomcli-shared', 'wecomcli-message', 'wecomcli-doc', 'wecomcli-sheet', 'wecomcli-smartsheet', 'wecomcli-todo', 'wecomcli-calendar', 'wecomcli-meeting'],
    },
    auth: {
      login: { command: 'wecom-cli', args: ['auth', 'init', '--noninteractive', '--no-browser'] },
      status: { command: 'wecom-cli', args: ['auth', 'show'] },
    },
    logoutFiles: {
      dir: '~/.config/wecom',
      envDir: 'WECOM_CLI_CONFIG_DIR',
      files: ['bot.enc', 'token.enc', 'credentials.enc', 'config.json'],
    },
    parseStatus: parseWecomStatus,
    parseLoginHint: textLoginHint,
  },
  hf: {
    id: 'hf',
    name: 'Hugging Face',
    vendor: 'Hugging Face',
    description: '通过官方 hf CLI 管理 Hugging Face：搜索与下载模型/数据集、上传文件、管理仓库、Spaces、Buckets、Jobs 与 Webhooks。',
    category: '知识检索',
    examples: [
      '搜一下 Hugging Face 上 Qwen 的量化模型，按下载量排序',
      '下载 meta-llama/Llama-3.2-1B-Instruct 到本地缓存',
      '把本地 ./model 目录上传到我账号下新建的模型仓库',
      '看看我昨天的 Jobs 跑完没有，失败的把日志摘要给我',
    ],
    docsUrl: 'https://huggingface.co/docs/hub/agents-cli',
    bin: 'hf',
    binCandidates: [HF_BIN],
    versionArgs: ['version', '--format', 'json'],
    loginTimeoutMs: 300_000,
    capabilities: { args: ['--help'], parse: parseHfCapabilities },
    install: [
      { label: '安装 hf CLI', command: 'uv', args: ['tool', 'install', 'huggingface_hub'] },
      { label: '安装 Hugging Face Skills', command: HF_BIN, args: ['skills', 'add', '-g'] },
    ],
    uninstall: [
      { label: '卸载 hf CLI', command: 'uv', args: ['tool', 'uninstall', 'huggingface-hub'] },
    ],
    skills: {
      expectedPrefix: 'hf-cli',
      expected: ['hf-cli'],
    },
    auth: {
      login: { command: 'hf', args: ['auth', 'login', '--format', 'agent'] },
      status: { command: 'hf', args: ['auth', 'whoami', '--format', 'json'] },
      logout: { command: 'hf', args: ['auth', 'logout'] },
    },
    parseStatus: parseHfStatus,
    parseLoginHint: textLoginHint,
  },
  'agent-mail': {
    id: 'agent-mail',
    name: 'Agent Mail',
    vendor: 'QQ 邮箱',
    description: '通过官方 agently-cli 操作 Agent Mail（QQ 邮箱为 Agent 打造的专属邮箱）：收发、回复、转发、搜索、附件与垃圾箱管理。',
    category: '办公协作',
    examples: [
      '给 alice@example.com 发一封邮件，主题【周会纪要】，正文用我给的要点',
      '看看我最近 10 封邮件，把需要今天回复的挑出来',
      '搜索最近一个月带【发票】的邮件，把附件下载到本地',
      '回复 msg_001，说明会议改到周四下午',
    ],
    docsUrl: 'https://agent.qq.com/doc/cli-setup.md',
    bin: 'agently-cli',
    versionArgs: ['--version'],
    loginTimeoutMs: 300_000,
    capabilities: { args: ['--help'], parse: parseAgentMailCapabilities },
    install: [
      { label: '安装 agently-cli', command: resolveNpmCommand(), args: ['install', '-g', '@tencent-qqmail/agently-cli'] },
      { label: '安装 Agent Mail Skills', command: resolveNpxCommand(), args: ['skills', 'add', 'https://agent.qq.com', '--skill', '-g', '-y'] },
    ],
    uninstall: [
      { label: '卸载 agently-cli', command: resolveNpmCommand(), args: ['uninstall', '-g', '@tencent-qqmail/agently-cli'] },
    ],
    skills: {
      expectedPrefix: 'agently-mail',
      expected: ['agently-mail'],
    },
    auth: {
      login: { command: 'agently-cli', args: ['auth', 'login'] },
      status: { command: 'agently-cli', args: ['auth', 'status'] },
      logout: { command: 'agently-cli', args: ['auth', 'logout'] },
    },
    parseStatus: parseAgentMailStatus,
    parseLoginHint: textLoginHint,
  },
}

export function getAdapter(id: string): CliAdapter | undefined {
  return (CLI_ADAPTERS as Record<string, CliAdapter | undefined>)[id]
}

export function listAdapters(): CliAdapter[] {
  return Object.values(CLI_ADAPTERS)
}