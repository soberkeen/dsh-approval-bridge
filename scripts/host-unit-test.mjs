// host-unit-test.mjs — host 半边行为测试（skill §0 铁律 2：node --check 不算验证）
// 覆盖：HUD 协议（build/parse/askHud 阻塞+超时+中止+清理）、sweepOrphans、
//       settings 白名单与损坏回退、决策日志尾读。
// 全部用临时目录，零副作用，跑完自删。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildRequest, askHud, parseResponse, sweepOrphans, cleanupRequest, cleanupRequestRetrying, atomicWriteJson } from '../lib/hud.js'
import { loadSettings, saveSettings, appendDecision, readDecisions, clearDecisions, SETTABLE, stateSettingsFile } from '../lib/settings.js'

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`) }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`) }
}

const root = mkdtempSync(join(tmpdir(), 'dah-test-'))
const drop = join(root, 'drop')
const resp = join(root, 'resp')

// 测试隔离：重定向 DSH 主目录，apply() 的 loadSettings/decisions 全部落进临时区
// （必须在调用 apply 之前生效；dshHome() 每次调用时读取环境变量，惰性求值无碍）
process.env.DSH_HOME = join(root, 'dshhome')

// ── buildRequest ──────────────────────────────────────────────────────────
{
  const r = buildRequest({ title: 't', body: 'b', timeoutSec: 110 })
  const hexOk = /^[0-9a-f]{32}$/.test(r.id)
  check('buildRequest：id 是 32 位 hex', hexOk, r.id)
  check('buildRequest：协议字段完整',
    r.app === 'dsh' && r.kind === 'confirm' && Array.isArray(r.buttons) && r.buttons.join() === '允许,拒绝'
      && r.timeout === 110 && Number.isInteger(r.created) && r.created > 0,
    JSON.stringify({ app: r.app, kind: r.kind, timeout: r.timeout }))
}

// ── parseResponse ─────────────────────────────────────────────────────────
{
  check('parseResponse：允许 → allow', parseResponse({ id: 'x', button: '允许' }) === 'allow')
  check('parseResponse：拒绝 → deny', parseResponse({ id: 'x', button: '拒绝' }) === 'deny')
  check('parseResponse：timeout 标记 → deny', parseResponse({ id: 'x', button: null, timeout: true }) === 'deny')
  check('parseResponse：不完整 → null（继续等待）', parseResponse({ id: 'x' }) === null && parseResponse(null) === null)
}

// ── askHud：正常决策路径（模拟 HUD 300ms 后写响应）────────────────────────
{
  const p = askHud({ dropDir: drop, respDir: resp, title: 't', body: 'b', timeoutSec: 5, pollMs: 50 })
  // 等请求文件出现再模拟 HUD 响应
  let id = null
  for (let i = 0; i < 50 && !id; i++) {
    await sleep(20)
    try {
      const name = require0(drop)
      if (name) id = name[0].replace(/\.json.*/, '')
    } catch { /* 目录还没建 */ }
  }
  check('askHud：drop 请求文件已投递', !!id, id ?? '未发现')
  writeFileSync(join(resp, `${id}.json`), JSON.stringify({ id, button: '允许' }))
  const r = await p
  check('askHud：阻塞到 HUD 决策（allow）', r.decision === 'allow' && !r.timeout && !r.cancelled, JSON.stringify(r))
  check('askHud：决策后 drop+resp 清理干净（需求⑥）',
    !existsSync(join(drop, `${id}.json`)) && !existsSync(join(resp, `${id}.json`)))
}
function require0(dir) {
  return readdirSync(dir).filter((n) => n.endsWith('.json'))
}

// ── askHud：超时路径（HUD 未响应 → 需求⑤）────────────────────────────────
{
  const t0 = Date.now()
  const r = await askHud({ dropDir: drop, respDir: resp, title: 't', body: 'b', timeoutSec: 1, pollMs: 100 })
  const wall = Date.now() - t0
  check('askHud：超时返回 decision=null+timeout=true', r.decision === null && r.timeout === true && !r.cancelled, JSON.stringify(r))
  check('askHud：超时耗时约 1 秒', wall >= 900 && wall < 2500, `${wall}ms`)
}

// ── 贴边 final poll：HUD timeout resp 在 deadline 前一瞬间落地也能读到 ────
{
  const p = askHud({ dropDir: drop, respDir: resp, title: 't', body: 'b', timeoutSec: 1, pollMs: 100 })
  await sleep(950) // deadline=1s：最后一次循环 poll 在 ~900ms（读不到），写完让 final poll 兜底
  const id = require0(drop)[0]?.replace(/\.json.*/, '')
  writeFileSync(join(resp, `${id}.json`), JSON.stringify({ id, button: null, timeout: true }))
  const r = await p
  check('askHud：贴边 timeout resp 被 final poll 读到（deny 而非超时）',
    r.decision === 'deny' && r.timeout === false, JSON.stringify(r))
}

// ── cleanupRequestRetrying：障碍消失后残留被重试删除 ─────────────────────
// 注：Node 的 openSync 自带 FILE_SHARE_DELETE，rmSync 照删——真实 EPERM 文件锁
// （杀毒扫描/独占句柄）无法在本进程内模拟。用「非空目录顶替同名文件」复现
// 「rmSync 失败 → leftover → 重试清零」的机制链路，EPERM 本身靠线上 warn 兜底。
{
  const id = 'f'.repeat(32)
  atomicWriteJson(join(drop, `${id}.json`), { id, app: 'dsh', kind: 'confirm' })
  mkdirSync(join(resp, `${id}.json`))
  writeFileSync(join(resp, `${id}.json`, 'occupied'), 'x') // 非空目录：rmSync 单文件模式必抛
  const left = cleanupRequest(drop, resp, id)
  check('cleanupRequest：删不掉的进入 leftovers', left.length === 1 && left[0].endsWith(`${id}.json`), JSON.stringify(left))
  rmSync(join(resp, `${id}.json`), { recursive: true }) // 障碍消失（等价于锁释放）
  await sleep(700) // 重试周期 200ms×N 内应清掉
  check('cleanupRequestRetrying：障碍消失后残留被删', !existsSync(join(resp, `${id}.json`)))
}

// ── askHud：signal 中止路径 ───────────────────────────────────────────────
{
  const ac = new AbortController()
  const p = askHud({ dropDir: drop, respDir: resp, title: 't', body: 'b', timeoutSec: 30, pollMs: 100, signal: ac.signal })
  await sleep(250)
  ac.abort()
  const r = await p
  check('askHud：signal 中止 → cancelled=true', r.cancelled === true && r.decision === null && !r.timeout, JSON.stringify(r))
}

// ── HUD 写半截文件（读响应时文件未写完）───────────────────────────────────
{
  const p = askHud({ dropDir: drop, respDir: resp, title: 't', body: 'b', timeoutSec: 2, pollMs: 60 })
  await sleep(150)
  // 先写半截，再写完整
  writeFileSync(join(resp, findReqId(drop) + '.json'), '{"id":"x","butt')
  await sleep(120)
  writeFileSync(join(resp, findReqId(drop) + '.json'), JSON.stringify({ id: findReqId(drop), button: '拒绝' }))
  const r = await p
  check('askHud：半截文件不误判，最终读到拒绝', r.decision === 'deny' && !r.timeout, JSON.stringify(r))
}

// ── resp 带 BOM（.NET UTF8 带 BOM 写手回写的防御，HANDOFF-DSH.md §3 ③）─────
{
  const p = askHud({ dropDir: drop, respDir: resp, title: 't', body: 'b', timeoutSec: 2, pollMs: 60 })
  await sleep(150)
  // 模拟旧版 HUD：内容前带 UTF-8 BOM（\uFEFF）
  writeFileSync(join(resp, findReqId(drop) + '.json'), '\uFEFF' + JSON.stringify({ id: findReqId(drop), button: '允许' }))
  const r = await p
  check('askHud：带 BOM 的 resp 剥 BOM 后读到允许', r.decision === 'allow' && !r.timeout, JSON.stringify(r))
}
function findReqId(dir) {
  for (const n of readdirSync(dir)) if (n.endsWith('.json')) return n.replace(/\.json.*/, '')
  return ''
}

// ── sweepOrphans ──────────────────────────────────────────────────────────
{
  mkdirSync(drop, { recursive: true })
  atomicWriteJson(join(drop, 'a'.repeat(32) + '.json'), { id: 'a'.repeat(32), app: 'dsh', kind: 'confirm' })
  atomicWriteJson(join(drop, 'b'.repeat(32) + '.json'), { id: 'b'.repeat(32), app: 'other-app', kind: 'confirm' })
  writeFileSync(join(drop, 'c.tmp'), 'junk')
  const n = sweepOrphans(drop)
  const left = readdirSync(drop)
  check('sweepOrphans：只清 app=dsh 的残留', n === 1 && left.includes('b'.repeat(32) + '.json') && !left.includes('a'.repeat(32) + '.json'),
    `removed=${n} left=${left.length}`)
}

// ── settings：默认值 / 白名单 / 损坏回退 ──────────────────────────────────
{
  const file = join(root, 'settings.json')
  const d1 = loadSettings(file)
  check('settings：默认值（需求③④）', d1.enabled === true && d1.timeoutSec === 110 && d1.pollMs === 200)
  const d2 = saveSettings({ timeoutSec: 30, enabled: false, evilKey: 'x', pollMs: 99999 }, file)
  check('settings：白名单过滤（evilKey 拒收、越界 pollMs 拒收）',
    d2.timeoutSec === 30 && d2.enabled === false && d2.pollMs === 200 && !('evilKey' in d2), JSON.stringify(d2))
  writeFileSync(file, '{broken json', 'utf8')
  const d3 = loadSettings(file)
  check('settings：配置损坏回落默认', d3.enabled === true && d3.timeoutSec === 110)
  const bad = SETTABLE.timeoutSec('not-a-number')
  check('settings：非数字拒收', bad === undefined)
}

// ── 决策日志：追加 / 尾读 / 清空 ───────────────────────────────────────────
{
  const file = join(root, 'decisions.jsonl')
  for (let i = 1; i <= 5; i++) appendDecision(file, { ts: 't' + i, tool: 'x', outcome: 'rejected', source: 'hud-fallback', detail: String(i) })
  const d = readDecisions(file, 3)
  check('决策日志：尾读 3 条、新的在前', d.length === 3 && d[0].detail === '5' && d[2].detail === '3', JSON.stringify(d.map((x) => x.detail)))
  appendDecision(file, { ts: 't6', tool: 'x', outcome: 'rejected', source: 'hud-fallback', detail: '6' })
  writeFileSync(file, 'not a json line\n', { flag: 'a' })
  check('决策日志：坏条目占位不抛错', readDecisions(file, 10).some((x) => x.outcome === 'parse-error'))
  clearDecisions(file)
  check('决策日志：清空', readDecisions(file, 10).length === 0)
}

// ── 并行平级裁决（race：原生链与 HUD 同时弹出，先到先得）──────────────────
{
  // 清空协议目录：前面 sweepOrphans 用例留了 2 个残留文件（other-app 的 b.json、c.tmp），
  // 会污染「文件计数」类断言
  rmSync(drop, { recursive: true, force: true })
  rmSync(resp, { recursive: true, force: true })
  const { apply } = await import('../lib/index.js')
  const effects = []
  const listeners = {}
  const ctxMock = {
    on: (ev, fn) => { (listeners[ev] ??= []).push(fn) },
    effect: (fn, name) => { effects.push({ name, fn }); return () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => null,
  }
  apply(ctxMock)
  const answerer = listeners['approval/request'][0]
  const mkReq = () => ({ toolName: 'race-tool', agent: { id: 'ag1' }, callId: 'c1', displayReason: '测试' })

  // 预置隔离配置：指向测试 drop/resp，短超时
  atomicWriteJson(stateSettingsFile(), {
    enabled: true, timeoutSec: 2, pollMs: 50, logMax: 200, dropDir: drop, respDir: resp,
  })

  // 场景 1：HUD 先赢（原生链挂起不返回）→ 投递即时、race 提前返回
  {
    const p = answerer(mkReq(), () => new Promise(() => {})) // 原生永不返回
    await sleep(150)
    const files = readdirSync(drop)
    check('race：HUD 气泡即时投递（不等原生）', files.length === 1, `${files.length} 个请求文件`)
    const id = files[0].replace(/\.json.*/, '')
    writeFileSync(join(resp, `${id}.json`), JSON.stringify({ id, button: '允许' }))
    const outcome = await p
    check('race：HUD 先赢 → allowed-once', outcome === 'allowed-once', outcome)
  }

  // 场景 2：原生先赢（300ms 出 allowed-once，HUD 无人响应）→ 原样返回 + HUD 收摊
  {
    const outcome = await answerer(mkReq(), async () => { await sleep(300); return 'allowed-once' })
    check('race：原生先赢 → 原样返回', outcome === 'allowed-once', outcome)
    await sleep(80)
    check('race：原生赢后 HUD 请求文件已收摊', readdirSync(drop).length === 0, `剩余 ${readdirSync(drop).length}`)
  }

  // 场景 3：原生 unavailable → HUD 继续独立裁决（兜底并入并行）
  {
    const p = answerer(mkReq(), async () => 'unavailable')
    await sleep(150)
    const id = readdirSync(drop)[0].replace(/\.json.*/, '')
    writeFileSync(join(resp, `${id}.json`), JSON.stringify({ id, button: '拒绝' }))
    const outcome = await p
    check('race：原生 unavailable → HUD 接管拒绝', outcome === 'rejected', outcome)
  }

  // 场景 4：原生 unavailable + HUD 超时（2s 配置）→ rejected
  {
    const outcome = await answerer(mkReq(), async () => 'unavailable')
    check('race：双渠道皆无 → HUD 超时拒绝（fail-closed）', outcome === 'rejected', outcome)
  }

  // 场景 5：agent 取消（request.signal abort）→ cancelled
  {
    const ac2 = new AbortController()
    const p = answerer({ ...mkReq(), signal: ac2.signal }, () => new Promise(() => {}))
    await sleep(150)
    ac2.abort()
    const outcome = await p
    check('race：agent 取消 → cancelled', outcome === 'cancelled', outcome)
  }

  // 场景 6：总开关关闭 → 纯透传、不投递 HUD
  {
    atomicWriteJson(stateSettingsFile(), {
      enabled: false, timeoutSec: 2, pollMs: 50, logMax: 200, dropDir: drop, respDir: resp,
    })
    const outcome = await answerer(mkReq(), async () => 'unavailable')
    check('race：disabled → unavailable 纯透传', outcome === 'unavailable', outcome)
    check('race：disabled → 未投递 HUD', readdirSync(drop).length === 0, `剩余 ${readdirSync(drop).length}`)
  }

  // 决策日志应有并行裁决痕迹（写到隔离 DSH_HOME 里）
  const decisions = readDecisions(stateSettingsFile().replace('settings.json', 'decisions.jsonl'), 10)
  check('race：决策日志记录并行来源', decisions.length >= 4, `${decisions.length} 条（sources: ${[...new Set(decisions.map((d) => d.source))].join(',')}）`)
}

// ── 收尾 ──────────────────────────────────────────────────────────────────
rmSync(root, { recursive: true, force: true })
console.log(`\n=== ${pass}/${pass + fail} 通过 ===`)
if (failures.length) {
  console.log('  失败清单：')
  for (const f of failures) console.log('   · ' + f)
}
process.exitCode = fail === 0 ? 0 : 1
