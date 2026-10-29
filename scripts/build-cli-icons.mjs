import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(root, 'assets', 'cli')
const outfile = join(root, 'src', 'client', 'cli-icons.generated.ts')

const MIME = {
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
}
const ids = ['dingtalk', 'feishu', 'tmeet', 'wecom']
const icons = {}

for (const id of ids) {
  const ext = Object.keys(MIME).find(candidate => existsSync(join(assetsDir, `${id}.${candidate}`)))
  if (ext === undefined) continue
  const file = join(assetsDir, `${id}.${ext}`)
  icons[id] = `data:${MIME[ext]};base64,${readFileSync(file).toString('base64')}`
}

const content = `// 由 scripts/build-cli-icons.mjs 生成，请勿手改。\n// 在 assets/cli/<id>.png|jpg|ico|svg 放置官方图标后重新运行 npm run cli:icons。\nexport const CLI_ICONS: Record<string, string> = ${JSON.stringify(icons, null, 2)}\n`
writeFileSync(outfile, content)
console.log(`cli icons: ${Object.keys(icons).length} (${Object.keys(icons).join(', ')})`)