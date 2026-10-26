import { fileURLToPath } from 'node:url'

import type { ConnectorCard } from '../shared/types.js'
import { loadProviders } from './providers.js'

interface BuiltinCatalog {
  version: number
  cards: ConnectorCard[]
}

const PROVIDERS_DIR = fileURLToPath(new URL('../../providers/', import.meta.url))

let cached: BuiltinCatalog | undefined

export function loadBuiltinCatalog(): BuiltinCatalog {
  if (cached !== undefined) return cached

  const { cards, issues } = loadProviders(PROVIDERS_DIR)
  for (const issue of issues) {
    console.warn(`[dsh-connectors] provider 配置错误 ${issue.file}: ${issue.message}`)
  }
  cached = { version: 3, cards }
  return cached
}
