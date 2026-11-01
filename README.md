# @dsh-external/dsh-agent-hud

> DSH approval bridge — route agent permission confirmations to a local desktop HUD sidebar.
>
> DSH 插件：把 agent 运行期间的**权限确认请求**桥接到本地 **Agent HUD** 桌面侧边栏。审批请求出现时，DSH 原生卡片与 HUD 角色气泡**同时弹出**，你在任意一边点「允许」或「拒绝」即可放行或阻断工具调用——远程裁决与本地裁决平级同权。

## 工作方式

- **并行平级**：审批请求出现时，DSH 原生卡片与 HUD 气泡**同时弹出**；在哪边裁决都生效，先到先得，另一边自动作废。
- **阻塞语义**：等待决策期间工具调用挂起，不会先斩后奏。
- **原生不可用也不怕**：DSH 原生 UI / ACP 渠道缺失时，HUD 独立完成裁决（fail-closed）。
- **超时保护**：默认 110 秒无响应按「拒绝」处理，不会误放行。
- **原子投递**：请求文件临时文件 + rename 原子写入，半截文件不会误判；响应剥 BOM 防御。
- **幂等清理**：决策后立即清理请求/响应文件（文件锁 EPERM 自动重试）；启动时清扫上次会话残留。

## 安装

```powershell
# 1. 克隆到任意目录（建议与 DSH profile 同盘）
git clone https://github.com/soberkeen/dsh-approval-bridge.git

# 2. 同步到插件源目录（DSH 插件生态的本地源惯例位置）
node scripts/sync-to-plugin-dir.mjs

# 3. 用 DSH 官方 CLI 装入 desktop profile（绝不手写 profile 文件或裸跑 pnpm）
dsh plugin --profile desktop add <插件源目录>/@dsh-external/dsh-agent-hud
```

重启 DSH 后，设置页出现「Agent HUD 审批桥」分区。

## 适配 Agent HUD（桌面侧边栏）

本插件通过**文件协议**与 Agent HUD（`agent-hud.exe`，Windows 桌面角色侧边栏）通信，无需 HUD 做任何 DSH 特化即可对接：

- 投递目录：`%LOCALAPPDATA%\AgentHUD\events\drop\<id>.json`（32 位 hex id）
- 响应目录：`%LOCALAPPDATA%\AgentHUD\events\resp\<id>.json`
- 请求 schema：`{id, app:'dsh', kind:'confirm', title, body, buttons:['允许','拒绝'], timeout, created}`
- 响应 schema：`{id, button:'允许'|'拒绝'|null, timeout:boolean}`（无 BOM 原子写）
- 监听要求：FSW 必须同时覆盖 `Created` + `Renamed` 事件（请求是同目录 rename 落地的，只挂 `Created` 会全盲）+ 启动扫描

完整协议契约、双侧职责与联调判据见 [HANDOFF-HUD.md](HANDOFF-HUD.md)。其他桌面通知前端想接入 DSH 审批流，实现同一协议即可。

## 设置

在 DSH 设置页（或 `~/.dsh/plugin-data/dsh-agent-hud/settings.json`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（关闭后插件完全不接管审批） |
| `timeoutSec` | `110` | 等待 HUD 决策的超时秒数 |
| `pollMs` | `200` | 响应文件轮询间隔 |
| `logMax` | `200` | 决策日志保留条数 |

决策日志：`~/.dsh/plugin-data/dsh-agent-hud/decisions.jsonl`，记录每一次裁决的时间、工具名、结果、来源（`hud` / `native` / `none`）与精确原因（内核 approval 链只传 outcome 字符串，精确原因在这里）。

## 本地 API（可选）

插件会尝试挂载 DSH webServer（不可用时静默降级）：

- `GET /@dsh-external/dsh-agent-hud/api/health`
- `GET|POST .../settings`
- `GET .../decisions?limit=N` · `POST .../clear-log`
- `POST .../test`（发一条 20 秒测试请求验证 HUD 连通）
- `POST .../sweep`（清扫孤儿请求文件）

## 开发与测试

```powershell
node --check lib/index.js               # 语法（不算验证）
node scripts/client-register-test.mjs   # client 契约测试（10 项）
node scripts/host-unit-test.mjs         # host 行为测试（35 项）
node scripts/hud-ping.mjs               # 端到端连通性测试（需 HUD 运行，30 秒窗口）
```

架构、内核契约出处与装配 SOP 见 [agent.md](agent.md)。

## License

[MIT](LICENSE)
