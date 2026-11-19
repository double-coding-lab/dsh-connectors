import { readFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'

import { loadBuiltinCatalog } from './host/catalog.js'
import { CliConnectorService, type CliServiceContext } from './host/cli/service.js'
import { ConnectionService, type ConnectionContext, type McpManagerFace } from './host/connections.js'
import { registerRoutes } from './host/routes.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

export const name = 'dsh-connectors'
export const version = pkg.version
export const inject = ['tools', 'storageDomain', 'loader', 'webServer']

const SERVICES = ['tools', 'storageDomain', 'loader', 'webServer', 'mcpManager'] as const

type LooseContext = Context & {
  get?: (name: string) => unknown
}

export async function apply(ctx: Context): Promise<() => void> {
  const loose = ctx as LooseContext
  const capabilities = (): Record<string, boolean> =>
    Object.fromEntries(SERVICES.map(service => [service, loose.get?.(service) !== undefined]))

  const connections = new ConnectionService(ctx as unknown as ConnectionContext, () => loadBuiltinCatalog().cards)
  const cli = new CliConnectorService(ctx as unknown as CliServiceContext)
  const disposeRoutes = registerRoutes(ctx, { version, capabilities, connections, cli })

  // mcpManager 自 DSH 0.2.2-rc.2 起提供；不放进必需依赖，旧宿主仍可用 loader 建连接
  const withManager = ctx as unknown as {
    inject: (deps: string[], callback: (inner: { mcpManager: McpManagerFace }) => () => void) => unknown
  }
  withManager.inject(['mcpManager'], (inner) => {
    void connections.attachManager(inner.mcpManager).catch((error: unknown) => {
      console.warn('[dsh-connectors] restore connections failed', error)
    })
    return () => connections.detachManager()
  })

  void connections.start().catch((error: unknown) => {
    console.warn('[dsh-connectors] restore connections failed', error)
  })

  const detectTimer = setTimeout(() => {
    void cli.detectAll().catch((error: unknown) => {
      console.warn('[dsh-connectors] CLI connector detect failed', error)
    })
  }, 2_000)
  detectTimer.unref?.()

  return () => {
    clearTimeout(detectTimer)
    disposeRoutes()
    void connections.dispose().catch((error: unknown) => {
      console.warn('[dsh-connectors] close storage failed', error)
    })
    void cli.dispose().catch((error: unknown) => {
      console.warn('[dsh-connectors] close CLI storage failed', error)
    })
  }
}
