import { readFileSync } from 'node:fs'

import type { ConnectorCard } from '../shared/types.js'

interface BuiltinCatalog {
  version: number
  cards: ConnectorCard[]
}

let cached: BuiltinCatalog | undefined

export function loadBuiltinCatalog(): BuiltinCatalog {
  if (cached !== undefined) return cached
  const url = new URL('../../catalog/builtin.json', import.meta.url)
  const parsed = JSON.parse(readFileSync(url, 'utf8')) as BuiltinCatalog
  if (!Array.isArray(parsed.cards)) throw new Error('catalog/builtin.json: cards must be an array')
  cached = parsed
  return parsed
}
