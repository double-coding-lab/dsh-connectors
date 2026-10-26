import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import type { ConnectorCard, ServerSpec } from '../shared/types.js'

export const PROVIDER_CATEGORIES = ['开发工具', '项目管理', '数据库', '知识检索', '办公协作', '其他'] as const

const httpsUrl = z.string().url().refine(value => value.startsWith('https://'), '必须使用 https 地址')

const instanceSchema = z.object({
  label: z.string().min(1),
  placeholder: z.string().min(1).optional(),
  hint: z.string().min(1).optional(),
}).strict()

export function isInstanceUrlTemplate(value: string): boolean {
  if (!value.startsWith('{instance}')) return false
  if (value.indexOf('{instance}', 1) !== -1) return false
  const rest = value.slice('{instance}'.length)
  return rest === '' || rest.startsWith('/')
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const authHelpSchema = z.object({
  url: httpsUrl,
  label: z.string().min(1),
  hint: z.string().min(1).optional(),
}).strict()

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({
    type: z.literal('bearer'),
    label: z.string().min(1),
    help: authHelpSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('header'),
    header: z.string().min(1),
    prefix: z.string().optional(),
    label: z.string().min(1),
    help: authHelpSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('oauth2'),
    flow: z.literal('pkce'),
    registration: z.union([
      z.literal('dcr'),
      z.object({ clientId: z.string().min(1) }).strict(),
    ]),
    scopes: z.array(z.string().min(1)).optional(),
    clientName: z.string().min(1).optional(),
    help: authHelpSchema.optional(),
  }).strict(),
])

export const providerDefinitionSchema = z.object({
  $schema: z.string().min(1).optional(),
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id 只能包含小写字母、数字和连字符'),
  name: z.string().min(1),
  vendor: z.string().min(1).optional(),
  category: z.enum(PROVIDER_CATEGORIES),
  summary: z.string().min(1),
  description: z.string().min(1).optional(),
  examples: z.array(z.string().min(1)).max(6).optional(),
  tags: z.array(z.string().min(1)).optional(),
  featured: z.boolean().optional(),
  order: z.number().int().nonnegative().optional(),
  instance: instanceSchema.optional(),
  server: z.object({
    serverName: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'serverName 只能包含小写字母、数字、下划线和连字符').optional(),
    transport: z.literal('streamable-http'),
    url: z.string().min(1),
  }).strict(),
  auth: authSchema,
}).strict().superRefine((provider, ctx) => {
  if (provider.instance !== undefined) {
    if (!isInstanceUrlTemplate(provider.server.url)) {
      ctx.addIssue({
        code: 'custom',
        path: ['server', 'url'],
        message: '带 instance 时 server.url 必须是以 {instance} 开头的模板，例如 {instance}/api/v4/mcp',
      })
    }
    return
  }
  if (!isHttpsUrl(provider.server.url)) {
    ctx.addIssue({
      code: 'custom',
      path: ['server', 'url'],
      message: '不带 instance 时必须使用 https 地址',
    })
  }
})

export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>

export interface ProviderIssue {
  file: string
  message: string
}

export interface ProviderLoadResult {
  cards: ConnectorCard[]
  issues: ProviderIssue[]
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`)
    .join('; ')
}

function toCard(provider: ProviderDefinition, serverName: string): ConnectorCard {
  const server: ServerSpec = {
    serverName,
    transport: provider.server.transport,
    url: provider.server.url,
  }
  return {
    id: provider.id,
    name: provider.name,
    vendor: provider.vendor,
    category: provider.category,
    summary: provider.summary,
    description: provider.description,
    examples: provider.examples,
    tags: provider.tags,
    published: true,
    featured: provider.featured,
    source: 'builtin',
    auth: provider.auth,
    ...(provider.instance === undefined ? {} : { instance: provider.instance }),
    server,
  }
}

export function loadProviders(directory: string): ProviderLoadResult {
  const issues: ProviderIssue[] = []
  if (!existsSync(directory)) {
    return { cards: [], issues: [{ file: directory, message: 'providers 目录不存在' }] }
  }

  const folders = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

  const loaded: Array<{ provider: ProviderDefinition; serverName: string }> = []
  const ids = new Map<string, string>()
  const serverNames = new Map<string, string>()

  for (const folder of folders) {
    const file = join(directory, folder, 'provider.json')
    if (!existsSync(file)) continue

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      issues.push({ file, message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` })
      continue
    }

    const parsed = providerDefinitionSchema.safeParse(raw)
    if (!parsed.success) {
      issues.push({ file, message: formatIssues(parsed.error) })
      continue
    }

    const provider = parsed.data
    if (provider.id !== folder) {
      issues.push({ file, message: `id "${provider.id}" 必须与目录名 "${folder}" 一致` })
      continue
    }
    const duplicateId = ids.get(provider.id)
    if (duplicateId !== undefined) {
      issues.push({ file, message: `id "${provider.id}" 与 ${duplicateId} 重复` })
      continue
    }
    const serverName = provider.server.serverName ?? provider.id
    const duplicateName = serverNames.get(serverName)
    if (duplicateName !== undefined) {
      issues.push({ file, message: `serverName "${serverName}" 与 ${duplicateName} 重复` })
      continue
    }
    ids.set(provider.id, file)
    serverNames.set(serverName, file)
    loaded.push({ provider, serverName })
  }

  loaded.sort((left, right) => {
    const order = (left.provider.order ?? 100) - (right.provider.order ?? 100)
    return order !== 0 ? order : left.provider.name.localeCompare(right.provider.name)
  })

  return {
    cards: loaded.map(({ provider, serverName }) => toCard(provider, serverName)),
    issues,
  }
}
