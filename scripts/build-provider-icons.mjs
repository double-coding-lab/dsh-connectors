import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const providersDir = join(root, 'providers')
const outfile = join(root, 'src', 'client', 'provider-icons.generated.ts')

const MIME = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' }
const icon = {}

const folders = readdirSync(providersDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()

for (const id of folders) {
  const ext = ['svg', 'png', 'webp'].find(candidate => existsSync(join(providersDir, id, `icon.${candidate}`)))
  if (ext === undefined) continue
  const file = join(providersDir, id, `icon.${ext}`)
  icon[id] = `data:${MIME[ext]};base64,${readFileSync(file).toString('base64')}`
}

const content = `// 由 scripts/build-provider-icons.mjs 生成，请勿手改。\n// 在 providers/<id>/icon.svg|png|webp 放置图标后重新运行 npm run providers:icons。\nexport const PROVIDER_ICONS: Record<string, string> = ${JSON.stringify(icon, null, 2)}\n`
writeFileSync(outfile, content)
console.log(`provider icons: ${Object.keys(icon).length} (${Object.keys(icon).join(', ')})`)
