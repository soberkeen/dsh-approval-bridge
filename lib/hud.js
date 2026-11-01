// lib/hud.js — Agent HUD 文件协议桥（零依赖，node: 内置）
//
// 协议（HUD 侧已实现且不改动，本插件是对接方）：
//   drop 目录：%LOCALAPPDATA%\AgentHUD\events\drop\   —— 插件写请求
//   resp 目录：%LOCALAPPDATA%\AgentHUD\events\resp\   —— HUD 写响应
//   请求：<id>.json  { id:32位hex, app:"dsh", kind:"confirm", title, body,
//                      buttons:["允许","拒绝"], timeout:110, created:unix秒 }
//   响应：<id>.json  { id, button:"允许"|"拒绝"|null, timeout:boolean }
//
// 需求行为映射（需求文档 §协议语义）：
//   ① 阻塞语义   —— waitForDecision 返回 Promise，调用方（approval answerer）必须 await
//   ② 原子写     —— tmp 文件 + renameSync（同盘 rename 原子）
//   ③ 轮询 200ms —— pollMs
//   ④ 超时 110s  —— timeoutSec
//   ⑤ HUD 未运行 —— timeout 到点仍无响应 = HUD 未响应，由调用方映射为拒绝
//   ⑥ 决策后清理 —— finally 里删 drop 与 resp 的本请求文件
//   ⑦ 幂等       —— 每请求独立 32 位 hex id；sweepOrphans 清理历史残留
//
// 裁决模式（用户定稿）：并行平级，先到先得。审批 answerer 收到请求后
// deliverRequest 立即投递（HUD 气泡与 DSH 原生卡片同时出现），
// 再与原生链结果 Promise.race——任一方先出决策即生效，另一方作废收摊。
// 原生链不可用（unavailable）时 HUD 独立裁决（兜底语义自然并入并行模式）。

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 生成 32 位 hex 请求 id。 */
export function newRequestId() {
  return randomBytes(16).toString('hex')
}

/**
 * 读 JSON 文件；不存在/损坏返回 null（HUD 写响应时可能读到半截文件，视为未就绪）。
 * 防御性剥 BOM（\uFEFF）：.NET Encoding.UTF8 默认带 BOM，若对端用带 BOM 写手回写 resp，
 * JSON.parse 会抛 SyntaxError 导致响应永远「未就绪」直到超时（HANDOFF-DSH.md §3 ③）。
 */
function readJsonSafe(file) {
  try {
    let s = readFileSync(file, 'utf8')
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** 原子写：写 <file>.<pid>.tmp 再 rename。写失败抛出（drop 写失败 = 桥不通，必须上抛）。 */
export function atomicWriteJson(file, obj) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(obj), 'utf8')
  renameSync(tmp, file)
}

/**
 * 构造 HUD 确认请求对象（协议字段固定，不可扩展——HUD 端按固定 schema 解析）。
 * @returns {{id: string, app: 'dsh', kind: 'confirm', title: string, body: string,
 *   buttons: string[], timeout: number, created: number}}
 */
export function buildRequest({ title, body, timeoutSec }) {
  return {
    id: newRequestId(),
    app: 'dsh',
    kind: 'confirm',
    title: String(title ?? 'DSH 权限确认'),
    body: String(body ?? ''),
    buttons: ['允许', '拒绝'],
    timeout: Math.max(5, Math.round(timeoutSec)),
    created: Math.floor(Date.now() / 1000),
  }
}

/**
 * 构造 HUD 通知请求对象（v0.2.0 新增：fire-and-forget 提醒，无按钮、无响应）。
 * 与 confirm 的区别：kind:'notify'、无 buttons 字段——HUD 侧 notify 气泡
 * 无按钮行、按自身 _life 定时收摊、消费后立即删除 drop 文件、不写 resp。
 * timeout 仅作为 HUD 气泡停留时长的参考值。
 * @returns {{id: string, app: 'dsh', kind: 'notify', title: string, body: string,
 *   timeout: number, created: number}}
 */
export function buildNotifyRequest({ title, body, timeoutSec = 10 }) {
  return {
    id: newRequestId(),
    app: 'dsh',
    kind: 'notify',
    title: String(title ?? 'DSH 通知'),
    body: String(body ?? ''),
    timeout: Math.max(3, Math.round(timeoutSec)),
    created: Math.floor(Date.now() / 1000),
  }
}

/**
 * 投递一条 notify 通知到 HUD（fire-and-forget：立即返回，不等待任何响应）。
 * HUD 消费 notify 后会自行删除 drop 文件；这里返回 id 供调用方安排延迟清理
 * （HUD 未运行时文件残留，由延迟清理兜底；正常路径清理时文件已不存在，静默跳过）。
 * drop 写失败上抛给调用方决定是否忽略（通知失败不能影响主链路）。
 * @returns {{id: string, app: 'dsh', kind: 'notify', title: string, body: string,
 *   timeout: number, created: number}}
 */
export function deliverNotify({ dropDir, title, body, timeoutSec }) {
  const req = buildNotifyRequest({ title, body, timeoutSec })
  mkdirSync(dropDir, { recursive: true })
  atomicWriteJson(join(dropDir, `${req.id}.json`), req)
  return req
}

/**
 * 解析 HUD 响应 → 标准化决策。
 * @returns {'allow'|'deny'|null} null = 响应不完整/字段不合法（继续等待）
 */
export function parseResponse(raw) {
  if (!raw || typeof raw !== 'object') return null
  const { button } = raw
  if (button === '允许') return 'allow'
  if (button === '拒绝') return 'deny'
  // button 为 null/其他值：若 HUD 明确标了 timeout，也按 deny 语义交给调用方
  if (raw.timeout === true) return 'deny'
  return null
}

/**
 * 清理本请求的残留文件（drop + resp；tmp 一并尝试）。任何失败静默——清理不影响主流程。
 * @returns {string[]} 删失败的文件路径（Windows 文件锁 EPERM 等场景），供调用方重试
 */
export function cleanupRequest(dropDir, respDir, id) {
  const leftovers = []
  for (const dir of [dropDir, respDir]) {
    if (!dir) continue
    for (const name of [`${id}.json`, `${id}.json.${process.pid}.tmp`]) {
      try {
        const f = join(dir, name)
        if (existsSync(f)) rmSync(f, { force: true })
      } catch {
        leftovers.push(join(dir, name))
      }
    }
  }
  return leftovers
}

/**
 * 异步收尾清理：立即删一轮，仍有残留（杀毒/索引器短暂锁文件导致的 EPERM，
 * 实测出现过：resp 决策已读走但删除失败，文件滞留到 HUD 10 分钟兜底才清）
 * 则每 200ms 重试，最多 10 次；彻底失败 warn 一次。仅限决策已拿到后的收尾用。
 */
export function cleanupRequestRetrying(dropDir, respDir, id, warn = () => {}) {
  let left = cleanupRequest(dropDir, respDir, id)
  if (left.length === 0) return
  let rounds = 0
  const timer = setInterval(() => {
    left = left.filter((f) => {
      try { rmSync(f, { force: true }); return false } catch { return true }
    })
    if (left.length === 0 || ++rounds >= 10) {
      clearInterval(timer)
      if (left.length > 0) warn(`清理残留失败（文件被占用）：${left.join(', ')}`)
    }
  }, 200)
  timer.unref?.()
}

/**
 * 清理 drop 目录里的孤儿请求（上一次进程崩溃/强杀留下的、永远不会被应答的请求文件）。
 * 只删 app === 'dsh' 的文件，不碰其他应用的请求。
 * @returns {number} 清理的文件数
 */
export function sweepOrphans(dropDir) {
  let n = 0
  let names = []
  try {
    if (!existsSync(dropDir)) return 0
    names = readdirSync(dropDir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.includes('.tmp')) continue
    try {
      const raw = readJsonSafe(join(dropDir, name))
      if (raw && raw.app === 'dsh' && raw.kind === 'confirm') {
        rmSync(join(dropDir, name), { force: true })
        n += 1
        const rid = String(raw.id ?? '')
        if (rid) cleanupRequest(dropDir, undefined, rid)
      }
    } catch { /* 单个文件失败不影响其余 */ }
  }
  return n
}

/**
 * 投递一条确认请求到 HUD（非阻塞，立即返回请求对象）。
 * 并行裁决模式的第一步：投递后由调用方自行决定何时开始等待决策。
 *
 * drop 写失败 = HUD 通道不通：上抛给调用方（不能静默放行）。
 * @returns {{id: string, app: 'dsh', kind: 'confirm', title: string, body: string,
 *   buttons: string[], timeout: number, created: number}}
 */
export function deliverRequest({ dropDir, respDir, title, body, timeoutSec }) {
  const req = buildRequest({ title, body, timeoutSec })
  mkdirSync(dropDir, { recursive: true })
  mkdirSync(respDir, { recursive: true })
  atomicWriteJson(join(dropDir, `${req.id}.json`), req)
  return req
}

/**
 * 阻塞等待一条已投递请求的 HUD 决策。
 *
 * @param {object} opts
 * @param {string} opts.dropDir   请求投递目录
 * @param {string} opts.respDir   响应轮询目录
 * @param {{id: string}} opts.req deliverRequest 返回的请求对象
 * @param {number} opts.timeoutSec 等待 HUD 决策的超时秒数（需求默认 110）
 * @param {number} [opts.pollMs]  resp 轮询间隔毫秒（需求默认 200）
 * @param {AbortSignal} [opts.signal] 中止信号：外部作废（并行裁决中另一方先赢）或 agent 取消
 * @returns {Promise<{decision: 'allow'|'deny'|null, timeout: boolean, cancelled: boolean,
 *   elapsedMs: number, id: string}>}
 *   - decision === 'allow'   用户在 HUD 点了「允许」
 *   - decision === 'deny'    用户点了「拒绝」，或 HUD 明确回 timeout
 *   - decision === null 且 timeout === true   HUD 未响应（需求⑤：调用方按拒绝处理）
 *   - cancelled === true     被 signal 中止（外部作废或 agent 取消）
 */
export async function waitForDecision({ dropDir, respDir, req, timeoutSec, pollMs = 200, signal, warn = () => {} }) {
  const started = Date.now()
  // 等待时长用调用方原始 timeoutSec（下限 1s）；req.timeout 是给 HUD 显示的倒计时，
  // 在 buildRequest 里单独钳了 ≥5s，两者语义不同，不能混用（否则 <5s 配置无效）。
  const deadline = started + Math.max(1, Math.round(timeoutSec)) * 1000
  const respFile = join(respDir, `${req.id}.json`)

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        return { decision: null, timeout: false, cancelled: true, elapsedMs: Date.now() - started, id: req.id }
      }
      const decision = parseResponse(readJsonSafe(respFile))
      if (decision !== null) {
        return { decision, timeout: false, cancelled: false, elapsedMs: Date.now() - started, id: req.id }
      }
      await sleep(pollMs)
    }
    // 贴边 final poll：HUD 倒计时归零写 timeout resp 的时刻 ≈ 本侧 deadline + 写盘延迟，
    // 实测差 36ms 漏读（resp 在 deadline 后落地、循环已退出）。退出后补读一次。
    const finalDecision = parseResponse(readJsonSafe(respFile))
    if (finalDecision !== null) {
      return { decision: finalDecision, timeout: false, cancelled: false, elapsedMs: Date.now() - started, id: req.id }
    }
    return { decision: null, timeout: true, cancelled: false, elapsedMs: Date.now() - started, id: req.id }
  } finally {
    cleanupRequestRetrying(dropDir, respDir, req.id, warn)
  }
}

/**
 * 向 HUD 发起一次阻塞式确认询问（deliverRequest + waitForDecision 的组合）。
 * 保留给 /test 连通性端点与独立使用场景；审批 answerer 走投递+竞速两段式。
 *
 * @param {object} opts 同 waitForDecision，另加 title/body
 * @returns {Promise<{decision: 'allow'|'deny'|null, timeout: boolean, cancelled: boolean,
 *   elapsedMs: number, id: string}>}
 */
export async function askHud({ dropDir, respDir, title, body, timeoutSec, pollMs = 200, signal, warn = () => {} }) {
  const req = deliverRequest({ dropDir, respDir, title, body, timeoutSec })
  return waitForDecision({ dropDir, respDir, req, timeoutSec, pollMs, signal, warn })
}

/**
 * 发起一次 HUD 连通性测试（设置页「测试 HUD」按钮）。
 * 与 askHud 相同协议，独立 id；等待上限单独控制，不受审批超时配置拖累。
 */
export async function probeHud({ dropDir, respDir, timeoutSec = 20, pollMs = 200 }) {
  const started = Date.now()
  const req = buildRequest({
    title: 'HUD 连通性测试',
    body: `来自 @dsh-external/dsh-agent-hud 的测试请求（${timeoutSec} 秒内响应即连通）`,
    timeoutSec,
  })
  const deadline = started + timeoutSec * 1000
  const respFile = join(respDir, `${req.id}.json`)
  mkdirSync(dropDir, { recursive: true })
  mkdirSync(respDir, { recursive: true })
  atomicWriteJson(join(dropDir, `${req.id}.json`), req)
  try {
    while (Date.now() < deadline) {
      const decision = parseResponse(readJsonSafe(respFile))
      if (decision !== null) {
        return { ok: true, decision, elapsedMs: Date.now() - started }
      }
      await sleep(pollMs)
    }
    // 贴边 final poll（同 waitForDecision：HUD timeout resp 可能贴着 deadline 落地）
    const finalDecision = parseResponse(readJsonSafe(respFile))
    if (finalDecision !== null) return { ok: true, decision: finalDecision, elapsedMs: Date.now() - started }
    return { ok: false, decision: null, elapsedMs: Date.now() - started }
  } finally {
    cleanupRequestRetrying(dropDir, respDir, req.id)
  }
}
