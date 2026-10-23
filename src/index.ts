import type { Context } from '@deepseek-ai/cordis'

import { loadBuiltinCatalog } from './host/catalog.js'
import { ConnectionService, type ConnectionContext } from './host/connections.js'
import { registerRoutes } from './host/routes.js'

export const name = 'dsh-connectors'
export const version = '0.1.0'
export const inject = ['tools', 'storageDomain', 'loader', 'webServer']

const SERVICES = ['tools', 'storageDomain', 'loader', 'webServer'] as const

type LooseContext = Context & {
  get?: (name: string) => unknown
}

export async function apply(ctx: Context): Promise<() => void> {
  const loose = ctx as LooseContext
  const capabilities = (): Record<string, boolean> =>
    Object.fromEntries(SERVICES.map(service => [service, loose.get?.(service) !== undefined]))

  const connections = new ConnectionService(ctx as unknown as ConnectionContext, () => loadBuiltinCatalog().cards)
  const disposeRoutes = registerRoutes(ctx, { version, capabilities, connections })

  void connections.restore().catch((error: unknown) => {
    console.warn('[dsh-connectors] restore connections failed', error)
  })

  return () => {
    disposeRoutes()
    void connections.dispose().catch((error: unknown) => {
      console.warn('[dsh-connectors] close storage failed', error)
    })
  }
}
