export type TransportKind = 'stdio' | 'streamable-http' | 'sse'

export interface AuthHelp {
  url: string
  label: string
  hint?: string
}

export type CardAuth =
  | { type: 'none' }
  | { type: 'bearer'; label: string; help?: AuthHelp }
  | { type: 'header'; header: string; prefix?: string; label: string; help?: AuthHelp }
  | {
    type: 'oauth2'
    flow: 'pkce'
    registration: 'dcr' | { clientId: string } | 'user'
    scopes?: string[]
    clientName?: string
    endpoints?: { authorization: string; token: string }
    authorizeParams?: Record<string, string>
    tokenMethod?: 'POST' | 'GET'
    pkce?: boolean
    help?: AuthHelp
  }

export interface ServerSpec {
  serverName: string
  transport: TransportKind
  url?: string
  command?: string
  args?: string[]
}

export interface ProviderInstancePreset {
  label: string
  url: string
  hint?: string
}

export interface ProviderInstance {
  label: string
  noun?: string
  placeholder?: string
  hint?: string
  help?: AuthHelp
  presets?: ProviderInstancePreset[]
}

export interface CustomTranslations {
  [locale: string]: { description?: string; category?: string; examples?: string[] }
}

export interface ConnectorCard {
  id: string
  name: string
  vendor?: string
  category: string
  categoryLabel?: string
  summary: string
  description?: string
  examples?: string[]
  translations?: Record<string, { name?: string; vendor?: string; summary?: string; description?: string; category?: string; examples?: string[] }>
  tags?: string[]
  published: boolean
  featured?: boolean
  source?: 'builtin' | 'custom'
  instance?: ProviderInstance
  auth: CardAuth
  server: ServerSpec
}

export interface ToolInfo {
  name: string
  description?: string
}

export interface ConnectionView {
  connectorId: string
  name: string
  serverName: string
  transport: TransportKind
  enabled: boolean
  authorized: boolean
  instanceReady?: boolean
  oauthClientReady?: boolean
  tools: string[]
  toolDetails: ToolInfo[]
  error?: string
  createdAt: number
}

export interface ConnectionsPayload {
  ok: true
  value: {
    connections: ConnectionView[]
  }
}

export interface CatalogPayload {
  ok: true
  value: {
    version: number
    cards: ConnectorCard[]
  }
}

export interface CustomConnectorsPayload {
  ok: true
  value: {
    connectors: ConnectorCard[]
  }
}

export interface CustomConfigView {
  json: string
  installed: boolean
}

export interface CustomConfigPayload {
  ok: true
  value: {
    config: CustomConfigView
  }
}

export interface CustomUpdatePayload {
  ok: true
  value: {
    card: ConnectorCard
    disconnected: boolean
  }
}

export interface OAuthStartPayload {
  ok: true
  value: {
    authorizeUrl: string
    flowId: string
    opened: boolean
  }
}

export interface OAuthStatusPayload {
  ok: true
  value: {
    status: 'pending' | 'done' | 'error' | 'expired'
    message?: string
  }
}

export interface HealthPayload {
  ok: true
  value: {
    name: string
    version: string
    capabilities: Record<string, boolean>
    node: string
  }
}

export const ROUTE_PREFIX = '/dsh-connectors'

export type CliConnectorId = 'dingtalk' | 'feishu' | 'tmeet' | 'wecom' | 'hf' | 'agent-mail'

export type CliPhase = 'idle' | 'installing' | 'updating' | 'configuring' | 'logging_in' | 'uninstalling' | 'error'

export interface CliCapabilityItem {
  id: string
  name: string
  description?: string
  count?: number
}

export interface CliCapabilitiesView {
  kind: 'products' | 'skills' | 'groups'
  total: number
  items: CliCapabilityItem[]
}

export interface CliConnectorView {
  id: CliConnectorId
  name: string
  vendor: string
  description: string
  category: string
  docsUrl: string
  examples: string[]
  installHint: string[]
  installed: boolean
  enabled: boolean
  version?: string
  authenticated: boolean
  account?: {
    name?: string
    email?: string
    org?: string
  }
  skills: {
    installed: boolean
    count: number
    names: string[]
    dir?: string
  }
  minVersion?: string
  versionOutdated?: boolean
  capabilities?: CliCapabilitiesView
  phase: CliPhase
  stage?: string
  link?: string
  code?: string
  output?: string
  lastError?: string
  updatedAt?: number
}

export interface CliListPayload {
  ok: true
  value: {
    connectors: CliConnectorView[]
  }
}

export interface CliConnectorPayload {
  ok: true
  value: {
    connector: CliConnectorView
  }
}

export interface CliActionPayload {
  ok: true
  value: {
    connector: CliConnectorView
  }
}

export interface CliLogPayload {
  ok: true
  value: {
    output: string
  }
}
