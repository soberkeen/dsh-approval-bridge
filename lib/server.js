// lib/server.js — dsh-agent-hud host 侧 HTTP API（单前缀路由，零编译零依赖）
//
// 注册形态（照抄 dsh-vault 实测契约）：
//   ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler }), label)
//   handler: (req, res) => void|Promise<void>，req/res 为 node 原生对象
//
// 端点：
//   GET  /health    运行环境与配置快照（零副作用）
//   GET  /settings  读配置
//   POST /settings  保存配置（白名单字段校验）
//   GET  /decisions 最近决策日志（?limit=N，新的在前）
//   POST /clear-log 清空决策日志
//   POST /test      HUD 连通性测试（阻塞等待，最长 20 秒）
//   POST /sweep     清理 drop 目录孤儿请求

import { existsSync } from 'node:fs'
import {
  clearDecisions, loadSettings, readDecisions, saveSettings,
  stateDecisionsFile, stateSettingsFile,
} from './settings.js'
import { probeHud, sweepOrphans } from './hud.js'

export const API_PREFIX = '/@dsh-external/dsh-agent-hud/api'

const MAX_BODY_BYTES = 256 * 1024
const PROBE_MAX_SEC = 20

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e?.message ?? e}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 创建 API 路由分发器。
 * @param {object} deps
 * @param {(entry: object) => void} deps.logDecision 追加决策日志（host 组装好条目后回调）
 * @param {(msg: string) => void} [deps.warn]
 */
export function createApi({ logDecision, warn = () => {} }) {
  /**
   * @param {import('node:http').IncomingMessage} req 完整请求（req.url 含 API 前缀，内部自剥）
   * @param {import('node:http').ServerResponse} res
   */
  return async function handle(req, res) {
    let subPath
    try {
      const url = new URL(req.url ?? '/', 'http://local')
      subPath = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname
      if (!subPath.startsWith('/')) subPath = `/${subPath}`
    } catch {
      return sendJson(res, 400, { error: 'invalid request url' })
    }
    const cfg = loadSettings()
    const url = new URL(subPath, 'http://local')
    const path = subPath.replace(/\/+$/, '') || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'GET' && path === '/health') {
      return sendJson(res, 200, {
        plugin: '@dsh-external/dsh-agent-hud',
        api: API_PREFIX,
        enabled: cfg.enabled,
        timeoutSec: cfg.timeoutSec,
        pollMs: cfg.pollMs,
        dropDir: cfg.dropDir,
        respDir: cfg.respDir,
        dropDirExists: existsSync(cfg.dropDir),
        respDirExists: existsSync(cfg.respDir),
        settingsFile: stateSettingsFile(),
        decisionsFile: stateDecisionsFile(),
        now: new Date().toISOString(),
      })
    }

    if (method === 'GET' && path === '/settings') {
      return sendJson(res, 200, cfg)
    }

    if (method === 'POST' && path === '/settings') {
      const patch = await readBody(req)
      const next = saveSettings(patch)
      return sendJson(res, 200, { ok: true, settings: next })
    }

    if (method === 'GET' && path === '/decisions') {
      const limit = Number(url.searchParams.get('limit') ?? 50)
      return sendJson(res, 200, { decisions: readDecisions(stateDecisionsFile(), Number.isFinite(limit) ? limit : 50) })
    }

    if (method === 'POST' && path === '/clear-log') {
      clearDecisions()
      return sendJson(res, 200, { ok: true })
    }

    if (method === 'POST' && path === '/test') {
      const result = await probeHud({
        dropDir: cfg.dropDir,
        respDir: cfg.respDir,
        timeoutSec: Math.min(cfg.timeoutSec, PROBE_MAX_SEC),
        pollMs: cfg.pollMs,
      })
      const verdict = result.ok
        ? `HUD 已响应（${result.decision === 'allow' ? '允许' : '拒绝'}，${result.elapsedMs}ms）`
        : `HUD 未响应（等待 ${result.elapsedMs}ms 后超时）——请确认 Agent HUD 正在运行`
      logDecision({
        ts: new Date().toISOString(),
        tool: '(连通性测试)',
        outcome: result.ok ? `hud-${result.decision}` : 'hud-timeout',
        source: 'probe',
        detail: verdict,
      })
      warn(`连通性测试：${verdict}`)
      return sendJson(res, 200, { ok: result.ok, ...result, verdict })
    }

    if (method === 'POST' && path === '/sweep') {
      const n = sweepOrphans(cfg.dropDir)
      return sendJson(res, 200, { ok: true, removed: n })
    }

    return sendJson(res, 404, { error: `no such endpoint: ${method} ${path}` })
  }
}
