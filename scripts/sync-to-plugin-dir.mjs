// sync-to-plugin-dir.mjs — 把开发目录同步到插件运行副本（<插件源目录>）
//
// 运行副本约束（skill §2）：ASCII 路径、与 profile 同盘（junction 限制）。
// 源目录含中文路径，不能直接被 junction 指向 —— 所以用「复制同步」而不是 link。
// 同步内容：package.json / cordis.patch.yml / lib/ / scripts/（不含 .ref、.git、node_modules）
//
// 用法：node scripts/sync-to-plugin-dir.mjs [--dry-run]

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..')
const PKG = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))
// 插件源目录（sync 目标根）解析：$DSH_SOURCE_DIR 显式指定；否则扫 ~/.dsh 下各目录，
// 找含 `<PKG.name>/package.json` 的那个（典型是 ~/.dsh/plugins-<profile>）。不硬编码目录名。
function detectSourceRoot() {
  if (process.env.DSH_SOURCE_DIR) return resolve(process.env.DSH_SOURCE_DIR)
  const dshHome = join(homedir(), '.dsh')
  const tried = []
  if (existsSync(dshHome)) {
    for (const n of readdirSync(dshHome)) {
      if (n === 'node_modules' || n === 'profiles') continue
      const c = join(dshHome, n)
      let isDir = false
      try {
        isDir = statSync(c).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      tried.push(c)
      if (existsSync(join(c, ...PKG.name.split('/'), 'package.json'))) return c
    }
  }
  throw new Error(
    `未找到本插件的源目录（需含 ${PKG.name}/package.json）。候选：${tried.join(' | ') || '无'}；` +
      '可用 $DSH_SOURCE_DIR 显式指定源目录根。',
  )
}
const DEST = join(detectSourceRoot(), PKG.name)

const dryRun = process.argv.includes('--dry-run')

const COPIES = ['package.json', 'cordis.patch.yml']
const DIRS = ['lib', 'scripts']
const SKIP_TOP = new Set(['.git', '.ref', 'node_modules', '.tmp'])

console.log(`源：${SRC}`)
console.log(`目标：${DEST}`)
if (dryRun) console.log('（dry-run：只打印计划，不写盘）')

mkdirSync(dirname(DEST), { recursive: true })

let n = 0
for (const f of COPIES) {
  const src = join(SRC, f)
  if (!existsSync(src)) continue
  console.log(`  复制文件  ${f}`)
  if (!dryRun) cpSync(src, join(DEST, f))
  n++
}
for (const d of DIRS) {
  const src = join(SRC, d)
  if (!existsSync(src)) continue
  console.log(`  复制目录  ${d}/`)
  if (!dryRun) {
    const dst = join(DEST, d)
    rmSync(dst, { recursive: true, force: true })
    cpSync(src, dst, { recursive: true })
  }
  n++
}
if (existsSync(DEST)) {
  for (const name of readdirSync(DEST)) {
    if (SKIP_TOP.has(name)) continue
    if (COPIES.includes(name) || DIRS.includes(name)) continue
    const st = statSync(join(DEST, name))
    if (st.isDirectory()) console.log(`  （目标里的多余目录不动：${name}/）`)
    else console.log(`  （目标里的多余文件不动：${name}）`)
  }
}
console.log(`\n完成：${n} 项${dryRun ? '（dry-run 未写盘）' : ''}`)
console.log('下一步：完全退出 DSH 再启动；验证设置页出现「Agent HUD 审批桥」分区。')
