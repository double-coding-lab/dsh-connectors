export type AuthMode = 'none' | 'bearer' | 'api-key' | 'fields' | 'oauth2-pkce'

export type TransportKind = 'stdio' | 'streamable-http'

export interface ServerSpec {
  key: string
  serverName: string
  transport: TransportKind
  url?: string
  command?: string
  args?: string[]
}

export interface ConnectorCard {
  id: string
  name: string
  vendor?: string
  icon?: string
  category: string
  summary: string
  description?: string
  examples?: string[]
  tags?: string[]
  published: boolean
  featured?: boolean
  source?: 'builtin' | 'custom'
  authMode: AuthMode
  authHeader?: string
  authPrefix?: string
  authLabel?: string
  authHelpUrl?: string
  authHelpLabel?: string
  authHelpHint?: string
  oauthProvider?: 'gitlab'
  servers: ServerSpec[]
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
