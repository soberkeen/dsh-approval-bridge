// lib/settings.js — dsh-agent-hud 配置与决策日志（零依赖，node: 内置）
//
// 状态目录约定（与 dsh-vault 同款）：~/.dsh/plugin-data/dsh-agent-hud/
//   settings.json   配置（原子写：tmp + rename）
//   decisions.jsonl 决策日志（每行一条 JSON，尾读 N 条）
//
// 需求映射（HDR 开关/DSH-插件需求.md）：
//   ⑤ HUD 未运行默认拒绝 —— 由 lib/hud.js 的超时语义承载（timeout = HUD 未响应）
//   ⑦ 幂等 —— 本文件只做覆盖式读改写，无累计副作用

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** DSH 主目录（DSH_HOME 优先，回退 ~/.dsh）。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (env && env.trim()) return env.trim()
  return join(homedir(), '.dsh')
}

/** 插件自己的状态目录。 */
export function stateDir(home = dshHome()) {
  return join(home, 'plugin-data', 'dsh-agent-hud')
}

export function stateSettingsFile(home = dshHome()) {
  return join(stateDir(home), 'settings.json')
}

export function stateDecisionsFile(home = dshHome()) {
  return join(stateDir(home), 'decisions.jsonl')
}

/** HUD 文件协议目录（需求方已实现的桌面侧，只读/写这两个目录）。 */
export function defaultHudDirs() {
  const root = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return {
    dropDir: join(root, 'AgentHUD', 'events', 'drop'),
    respDir: join(root, 'AgentHUD', 'events', 'resp'),
  }
}

export const DEFAULTS = () => ({
  /** 总开关：false 时插件完全旁路（unavailable 原样透传，维持内核 fail-closed）。 */
  enabled: true,
  /** 等待 HUD 决策的超时秒数（需求：110 秒）。 */
  timeoutSec: 110,
  /** 轮询 resp 目录的间隔毫秒（需求：200ms）。 */
  pollMs: 200,
  ...defaultHudDirs(),
  /** 决策日志最多保留条数（jsonl 只追加，读时裁剪展示；clear-log 真正清空）。 */
  logMax: 200,
  /** 提问通知（v0.2.0）：DSH 发起提问时投 HUD notify 提醒（无按钮，作答仍走原生卡片）。 */
  questionNotify: true,
  /** 任务完成通知（v0.2.0）：每个 agent 回合结束（turn-stopping）时投 HUD notify 提醒。 */
  turnNotify: true,
})

/** 配置字段白名单与取整范围（POST /settings 只接受这些键）。 */
export const SETTABLE = {
  enabled: (v) => typeof v === 'boolean' ? v : undefined,
  questionNotify: (v) => typeof v === 'boolean' ? v : undefined,
  turnNotify: (v) => typeof v === 'boolean' ? v : undefined,
  timeoutSec: (v) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= 5 && n <= 600 ? n : undefined
  },
  pollMs: (v) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= 50 && n <= 5000 ? n : undefined
  },
  dropDir: (v) => typeof v === 'string' && v.trim() ? v.trim() : undefined,
  respDir: (v) => typeof v === 'string' && v.trim() ? v.trim() : undefined,
  logMax: (v) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= 10 && n <= 5000 ? n : undefined
  },
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写 JSON：同目录 tmp 文件 + rename（同盘 rename 原子）。 */
export function atomicWriteJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 读配置：磁盘值覆盖默认值，非法值回落默认（配置损坏不能拖垮审批链）。 */
export function loadSettings(file = stateSettingsFile()) {
  const disk = readJsonSafe(file, {})
  const base = DEFAULTS()
  const merged = { ...base }
  for (const key of Object.keys(SETTABLE)) {
    const clean = SETTABLE[key](disk?.[key])
    if (clean !== undefined) merged[key] = clean
  }
  return merged
}

/** 保存配置（增量 patch，过白名单过滤后合并）。返回保存后的完整配置。 */
export function saveSettings(patch, file = stateSettingsFile()) {
  const current = loadSettings(file)
  for (const key of Object.keys(SETTABLE)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      const clean = SETTABLE[key](patch[key])
      if (clean !== undefined) current[key] = clean
    }
  }
  atomicWriteJson(file, current)
  return current
}

/** 追加一条决策日志（jsonl；写失败只告警不抛——日志不能影响审批主链路）。 */
export function appendDecision(file, entry, warn = () => {}) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
  } catch (e) {
    warn(`决策日志写入失败（忽略）：${e?.message ?? e}`)
  }
}

/** 读最近 n 条决策日志（新的在前）。文件缺失/损坏返回空数组。 */
export function readDecisions(file, n = 50) {
  if (!existsSync(file)) return []
  let lines = []
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  } catch {
    return []
  }
  const tail = lines.slice(-Math.max(1, Math.min(500, n)))
  const out = []
  for (const line of tail) {
    try {
      out.push(JSON.parse(line))
    } catch {
      out.push({ ts: '', tool: '', outcome: 'parse-error', source: 'hud', detail: line.slice(0, 120) })
    }
  }
  return out.reverse()
}

/** 清空决策日志（重置为空文件）。 */
export function clearDecisions(file = stateDecisionsFile()) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '', 'utf8')
}
