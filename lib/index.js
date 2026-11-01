// lib/index.js — @dsh-external/dsh-agent-hud host 半边
//
// 定位（用户定稿「并行平级、先到先得」模式）：
//   DSH 原生审批链（waterfall "approval/request"）上，本插件是最外层应答器：
//   1. 收到审批请求 → 立即把确认投递到 Agent HUD（非阻塞）——HUD 气泡与
//      DSH 原生卡片同时出现，双方平级；
//   2. next() 放行给原生链（原生 UI 卡片 / ACP / 其他应答器），两者并行等待；
//   3. Promise.race 先到先得：任一方先出决策即生效，另一方作废收摊
//      （HUD 侧 abort 清理文件；原生侧弃权，用户后点的返回值无人消费）；
//   4. 原生链先返回但 'unavailable'（无任何渠道）→ HUD 继续独立裁决
//      （原兜底语义自然并入并行模式）；
//   5. HUD 超时（需求默认 110 秒）→ 'rejected'（fail-closed）。
//
// 内核契约（实测，0.2.1-rc.3 asar）：
//   - dsh-user-approval ApprovalService.decide():
//       ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req,
//         () => Promise.resolve("unavailable"))
//   - ApprovalOutcome 枚举：'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
//     （非枚举值会被归一为 'unavailable'，绝不能返回自定义字符串）
//   - cordis waterfall 监听器按注册顺序组洋葱链，先注册 = 外层；插件在启动期
//     apply，先于 remote 桥 / ACP 的运行期注册，天然位于最外层
//   - 先例 dsh-acp/lib/index.js:1158 在根 ctx 上 ctx.on("approval/request", ...) 可达
//   - ApprovalOutcome 只是字符串，answerer 无法附自定义 reason；HUD 未响应的精确
//     文案记录在决策日志（decisions.jsonl）里，工具反馈用内核标准文案。
//
// 需求行为映射（HDR 开关/DSH-插件需求.md）：
//   ① 阻塞语义 —— listener 内 await race，绝不 fire-and-forget
//   ②③④⑤⑥⑦ —— 由 lib/hud.js 承载（原子写/200ms 轮询/110s 超时/超时即拒/清理/幂等）

import { createApi, API_PREFIX } from './server.js'
import { appendDecision, loadSettings, stateDecisionsFile } from './settings.js'
import { deliverRequest, sweepOrphans, waitForDecision } from './hud.js'

export const name = '@dsh-external/dsh-agent-hud'

/**
 * 不声明任何服务依赖：approval 事件监听与文件协议都是 Context 基础能力；
 * webServer 用 ctx.get 可选挂载（缺服务时审批桥照常工作，仅设置页 UI 不可达）。
 */
export const inject = []

/** 安全字符串化（日志字段不抛错）。 */
function safeText(v, max = 200) {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s === undefined) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function apply(ctx, config = {}) {
  const log = (msg) => ctx.logger?.info?.(`[dsh-agent-hud] ${msg}`)
  const warn = (msg) => ctx.logger?.warn?.(`[dsh-agent-hud] ${msg}`)
  const decide = (entry) =>
    appendDecision(stateDecisionsFile(), entry, (m) => warn(m))

  const cfg = loadSettings()
  log(`已加载：enabled=${cfg.enabled} timeout=${cfg.timeoutSec}s poll=${cfg.pollMs}ms drop=${cfg.dropDir}`)

  // 启动时清理上次进程残留的孤儿请求（需求⑦幂等；只清 app === 'dsh' 的文件）
  try {
    const swept = sweepOrphans(cfg.dropDir)
    if (swept > 0) log(`已清理 ${swept} 个孤儿请求文件`)
  } catch (e) {
    warn(`孤儿清理失败（忽略）：${e?.message ?? e}`)
  }

  // ── 核心：approval/request 并行平级应答器 ────────────────────────────────
  ctx.on('approval/request', async (request, next) => {
    const cfgNow = loadSettings()
    if (!cfgNow.enabled) return next() // 总开关关闭：纯透传，完全不介入

    const toolName = safeText(request?.toolName, 80) || '(未知工具)'
    const agentId = safeText(request?.agent?.id ?? request?.agent, 80)
    const askReason = safeText(request?.displayReason ?? request?.reason, 300)
    const callId = safeText(request?.callId, 80)
    const ts = () => new Date().toISOString()

    // 收摊协调器：任一方出结果 / 审批被 agent 取消 → 通知 HUD 等待退出
    const ac = new AbortController()
    const onReqAbort = () => ac.abort()
    request?.signal?.addEventListener('abort', onReqAbort, { once: true })

    // 侧 1：HUD —— 立即投递（非阻塞），HUD 气泡此刻出现，与原生卡片同时可见
    let hudP = null
    try {
      const hudReq = deliverRequest({
        dropDir: cfgNow.dropDir,
        respDir: cfgNow.respDir,
        title: `DSH 权限确认 · ${toolName}`,
        body: askReason
          ? `工具「${toolName}」请求执行许可：\n${askReason}\n\n允许 / 拒绝（${cfgNow.timeoutSec} 秒未响应将自动拒绝）`
          : `工具「${toolName}」请求执行许可。\n\n允许 / 拒绝（${cfgNow.timeoutSec} 秒未响应将自动拒绝）`,
        timeoutSec: cfgNow.timeoutSec,
      })
      hudP = waitForDecision({
        dropDir: cfgNow.dropDir,
        respDir: cfgNow.respDir,
        req: hudReq,
        timeoutSec: cfgNow.timeoutSec,
        pollMs: cfgNow.pollMs,
        signal: ac.signal,
      })
    } catch (e) {
      // HUD 通道不通（目录写失败等）：本次退化为纯原生裁决，不影响内核行为
      warn(`HUD 通道异常，本次仅原生裁决：${e?.message ?? e}`)
      hudP = null
    }

    // 侧 2：原生链 —— next() 不先 await，拿 promise 与 HUD 并行竞速。
    // 只有原生「真裁决」（非 unavailable）才收摊 HUD；unavailable 表示没有渠道，
    // HUD 必须继续等待独立裁决（兜底语义），此时 abort 会把接管误杀成 cancelled。
    const nativeP = (async () => {
      try {
        const outcome = await next()
        if (outcome !== 'unavailable') ac.abort()
        return outcome
      } finally {
        // 异常路径也要尽力收摊；正常「真裁决」的 abort 已在上面发生
      }
    })()

    let winner
    if (!hudP) {
      winner = { side: 'native', outcome: await nativeP }
    } else {
      winner = await Promise.race([
        nativeP.then((outcome) => ({ side: 'native', outcome })),
        hudP.then((r) => ({ side: 'hud', r })),
      ])
      // 原生链先返回但无任何渠道可用 → HUD 继续独立裁决（兜底并入并行）
      if (winner.side === 'native' && winner.outcome === 'unavailable') {
        winner = { side: 'hud', r: await hudP }
      }
    }

    // 收摊：中止 HUD 等待（若还在挂）；吃掉两侧 promise 防 unhandled rejection
    ac.abort()
    hudP?.catch(() => {})
    nativeP.catch(() => {})
    request?.signal?.removeEventListener('abort', onReqAbort)

    // ── 原生侧胜出 ────────────────────────────────────────────────────────
    if (winner.side === 'native') {
      const outcome = winner.outcome
      if (outcome !== 'unavailable') {
        log(`原生渠道裁决 ${toolName}：${outcome}`)
        decide({
          ts: ts(), tool: toolName, agent: agentId, callId,
          outcome, source: 'native',
          detail: '用户在 DSH 原生渠道（卡片/ACP）裁决，HUD 气泡作废',
        })
        return outcome
      }
      // unavailable 且 HUD 通道异常（hudP 为 null）：维持内核 fail-closed 语义
      decide({
        ts: ts(), tool: toolName, agent: agentId, callId,
        outcome: 'unavailable', source: 'none',
        detail: '无任何审批渠道（原生 unavailable 且 HUD 通道异常）',
      })
      return 'unavailable'
    }

    // ── HUD 侧胜出 ────────────────────────────────────────────────────────
    const r = winner.r

    if (r.cancelled) {
      log(`审批请求已被中止（agent 取消），HUD 等待 ${r.elapsedMs}ms 后退出`)
      decide({
        ts: ts(), tool: toolName, agent: agentId, callId,
        outcome: 'cancelled', source: 'hud',
        detail: '审批请求在等待期间被中止（agent 取消）',
      })
      return 'cancelled'
    }

    if (r.decision === 'allow') {
      log(`HUD 放行：${toolName}（${r.elapsedMs}ms）`)
      decide({
        ts: ts(), tool: toolName, agent: agentId, callId,
        outcome: 'allowed-once', source: 'hud',
        detail: `用户在 HUD 点「允许」（${r.elapsedMs}ms），原生卡片作废`,
      })
      return 'allowed-once'
    }

    // deny 或超时：需求⑤ —— HUD 未响应（timeout）按拒绝处理，精确文案进日志
    const detail = r.timeout
      ? `HUD 未响应（${cfgNow.timeoutSec} 秒超时，共等待 ${r.elapsedMs}ms）——按拒绝处理`
      : `用户在 HUD 点「拒绝」（${r.elapsedMs}ms），原生卡片作废`
    warn(`HUD 拒绝 ${toolName}：${detail}`)
    decide({
      ts: ts(), tool: toolName, agent: agentId, callId,
      outcome: 'rejected', source: 'hud',
      detail,
    })
    return 'rejected'
  })

  // ── 设置页 UI 通道：webServer 单前缀路由（可选挂载，缺服务不影响审批桥）────
  const mountUi = () => {
    let webServer
    try {
      webServer = ctx.get('webServer')
    } catch {
      return false
    }
    if (!webServer || typeof webServer.register !== 'function') return false
    const api = createApi({ logDecision: decide, warn })
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        Promise.resolve(api(req, res)).catch((e) => {
          warn(`API 处理失败：${e?.message ?? e}`)
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: safeText(e?.message ?? e, 200) }))
          } catch { /* 响应已发出 */ }
        })
      },
    }), 'dsh-agent-hud: api route')
    log(`UI 通道：${API_PREFIX}`)
    return true
  }
  if (!mountUi()) {
    // host 可能比本插件晚挂上 webServer（cordis 激活顺序）→ 后台重试后放弃
    ctx.effect(() => {
      let tries = 0
      const timer = setInterval(() => {
        tries += 1
        if (mountUi() || tries >= 10) {
          clearInterval(timer)
          if (tries >= 10) warn('webServer 始终不可用：设置页 UI 通道跳过（审批桥不受影响）')
        }
      }, 700)
      return () => clearInterval(timer)
    }, 'dsh-agent-hud: ui mount retry')
  }

  log('审批桥就绪：并行平级模式——原生渠道与 Agent HUD 同时弹出，先到先得')
}
