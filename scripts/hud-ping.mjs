// scripts/hud-ping.mjs — Agent HUD 全链路连通性测试（联调/回归验证用）
//
// 用法：node scripts/hud-ping.mjs   （30 秒窗口）
// 行为：按文件协议向 %LOCALAPPDATA%\AgentHUD\events\drop\ 投递一条
//       「HUD 连通性测试」确认请求（tmp+rename 原子写，与审批桥同款），
//       阻塞等待 HUD 回写 resp。
// 全通判据：HUD 弹出气泡 → 用户点「允许」→ 本脚本输出 {"ok":true,"decision":"allow"}。
// 超时输出 {"ok":false,...} = 链路断（检查 HUD 监听/渲染/回写，见 HANDOFF-HUD.md §4.4）。
import { probeHud } from '../lib/hud.js'
import { defaultHudDirs } from '../lib/settings.js'

const { dropDir, respDir } = defaultHudDirs()
console.log('drop:', dropDir)
console.log('resp:', respDir)
console.log('发送中…（HUD 应弹出「HUD 连通性测试」气泡，30 秒窗口）')

const t0 = Date.now()
const r = await probeHud({ dropDir, respDir, timeoutSec: 30 })
console.log(`耗时 ${(Date.now() - t0) / 1000}s`)
console.log('结果:', JSON.stringify(r))
process.exitCode = r.ok ? 0 : 1
