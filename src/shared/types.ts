export type TransportKind = 'stdio' | 'streamable-http'

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
    registration: 'dcr' | { clientId: string }
    scopes?: string[]
    clientName?: string
    help?: AuthHelp
  }

export interface ServerSpec {
  serverName: string
  transport: TransportKind
  url?: string
  command?: string
  args?: string[]
}

export interface ProviderInstance {
  label: string
  placeholder?: string
  hint?: string
}

export interface ConnectorCard {
  id: string
  name: string
  vendor?: string
  category: string
  summary: string
  description?: string
  examples?: string[]
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
