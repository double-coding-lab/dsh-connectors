import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import * as exec from '../dist/host/cli/exec.js'

assert.equal(typeof exec.findExecutable, 'function', 'findExecutable 应该由 exec 模块导出')

const dir = mkdtempSync(join(tmpdir(), 'dsh-exec-'))
const exeName = process.platform === 'win32' ? 'dsh-test-bin.exe' : 'dsh-test-bin'
const exePath = join(dir, exeName)
copyFileSync(process.execPath, exePath)

const env = {
  PATH: dir,
  PATHEXT: '.EXE;.CMD',
}
const samePath = (actual, expected) => process.platform === 'win32'
  ? actual?.toLowerCase() === expected.toLowerCase()
  : actual === expected

try {
  assert.ok(samePath(exec.findExecutable('dsh-test-bin', env), exePath))

  assert.ok(samePath(
    exec.findExecutable('dsh-test-bin', { ...env, PATH: `"${dir}"${delimiter}${join(dir, 'missing')}` }),
    exePath,
  ), 'PATH 中带引号的目录也应该被解析')

  assert.equal(exec.findExecutable('dsh-missing-bin-zzz', env), null)

  assert.equal(
    await exec.resolveBinary('dsh-missing-bin-zzz', [exePath], env),
    exePath,
    'preferred 候选应优先于 PATH 查找',
  )

  assert.equal(await exec.resolveBinary('dsh-missing-bin-zzz', [], env), null)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('exec tests: passed')
