import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const authSchema = z.object({
  mode: z.enum(['bearer', 'api-key']),
  header: z.string().min(1),
  prefix: z.string(),
  token: z.string().min(1),
})

const oauthSchema = z.object({
  provider: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  redirectUri: z.string().url().optional(),
  tokenEndpoint: z.string().url(),
  authorizationEndpoint: z.string().url(),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
  resource: z.string().url().optional(),
})

export const connectionRecordSchema = z.object({
  key: z.string().min(1),
  connectorId: z.string().min(1),
  name: z.string().min(1),
  serverName: z.string().min(1),
  transport: z.enum(['streamable-http', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  auth: authSchema.optional(),
  oauth: oauthSchema.optional(),
  enabled: z.boolean(),
  lastError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type ConnectionRecord = z.infer<typeof connectionRecordSchema>

export const customConnectorSchema = z.object({
  key: z.string().min(1),
  connectorId: z.string().min(1),
  name: z.string().min(1),
  serverName: z.string().min(1),
  transport: z.enum(['streamable-http', 'stdio']),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  category: z.string().min(1).max(64).optional(),
  description: z.string().min(1).max(120).optional(),
  examples: z.array(z.string().min(1)).max(6).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type CustomConnectorRecord = z.infer<typeof customConnectorSchema>

export function defineConnectorDomain() {
  return defineDomain({
    name: 'dsh_connectors',
    version: 1,
    tables: {
      connections: domainTable<string, ConnectionRecord>(connectionRecordSchema),
      custom_connectors: domainTable<string, CustomConnectorRecord>(customConnectorSchema),
    },
  })
}

export const cliConnectorRecordSchema = z.object({
  key: z.string().min(1),
  connectorId: z.string().min(1),
  installed: z.boolean().optional(),
  enabled: z.boolean().optional(),
  installedVersion: z.string().optional(),
  authenticated: z.boolean(),
  account: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    org: z.string().optional(),
  }).optional(),
  skillsCount: z.number().int().nonnegative().optional(),
  lastError: z.string().optional(),
  lastCheckedAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type CliConnectorRecord = z.infer<typeof cliConnectorRecordSchema>

export function defineCliDomain() {
  return defineDomain({
    name: 'dsh_connectors_cli',
    version: 1,
    tables: {
      cli_connectors: domainTable<string, CliConnectorRecord>(cliConnectorRecordSchema),
    },
  })
}
