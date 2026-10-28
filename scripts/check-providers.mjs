import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadProviders } from '../dist/host/providers.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const providersDir = join(root, 'providers')

if (!existsSync(providersDir)) {
  console.error('providers 目录不存在')
  process.exit(1)
}

const { cards, issues } = loadProviders(providersDir)

for (const issue of issues) {
  console.error(`✗ ${issue.file}\n  ${issue.message}`)
}

if (issues.length > 0) {
  console.error(`\nprovider 校验失败：${issues.length} 个问题`)
  process.exit(1)
}

for (const card of cards) {
  const icon = ['svg', 'png', 'webp'].some(ext => existsSync(join(providersDir, card.id, `icon.${ext}`)))
  console.log(`✓ ${card.id.padEnd(12)} ${card.auth.type.padEnd(7)} ${card.server.transport}  ${card.instance !== undefined ? '用户填写地址' : card.server.url}${icon ? '' : '  (无图标，使用字母兜底)'}`)
}

console.log(`\nprovider 校验通过：${cards.length} 个`)
