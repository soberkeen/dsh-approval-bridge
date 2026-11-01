# @dsh-external/dsh-agent-hud

> **配套项目**：[Agent HUD](https://github.com/soberkeen/agent-hud) —— Windows 桌面角色侧边栏（气泡通知宿主）。本插件是 **Agent HUD 的 DSH（DeepSeek Harness）通知适配辅助插件**：把 DSH 运行期的权限确认、提问、任务回合完成事件桥接到 Agent HUD 气泡。

> DSH approval bridge — route agent permission confirmations to a local desktop HUD sidebar.
>
> DSH 插件（v0.2.0）：把 agent 运行期间的三类事件桥接到本地 **Agent HUD** 桌面侧边栏。**权限确认**双通道并行——DSH 原生卡片与 HUD 角色气泡同时弹出，任意一边点「允许/拒绝」即生效，先到先得；**DSH 提问**与**任务回合完成**以 HUD 纯提醒气泡（notify，无按钮）告知，无需操作。

## 工作方式

**权限确认（confirm，双向裁决）**

- **并行平级**：审批请求出现时，DSH 原生卡片与 HUD 气泡**同时弹出**；在哪边裁决都生效，先到先得，另一边自动作废。
- **阻塞语义**：等待决策期间工具调用挂起，不会先斩后奏。
- **原生不可用也不怕**：DSH 原生 UI / ACP 渠道缺失时，HUD 独立完成裁决（fail-closed）。
- **超时保护**：默认 110 秒无响应按「拒绝」处理，不会误放行。

**DSH 提问 / 任务回合完成（notify，纯提醒）**

- DSH 发起提问（内核 `user-questions/request`）→ HUD 弹「DSH 提问」提醒气泡（正文含问题文本）；**作答仍在 DSH 原生问答卡片**——插件只提醒，绝不拦截提问链路。
- agent 回合结束（内核 `agent/turn-stopping`）→ HUD 弹「DSH 任务回合完成」气泡。
- 两者均 fire-and-forget：投递即忘，不等待、不阻塞、各有独立开关。

**通用工程质量**

- **原子投递**：请求文件临时文件 + rename 原子写入，半截文件不会误判；响应剥 BOM 防御。
- **幂等清理**：决策后立即清理请求/响应文件（文件锁 EPERM 自动重试）；启动时清扫上次会话残留；notify 残留 60 秒延迟清理兜底。

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

本插件通过**文件协议**与 [Agent HUD](https://github.com/soberkeen/agent-hud)（`agent-hud.exe`，Windows 桌面角色侧边栏）通信，无需 HUD 做任何 DSH 特化即可对接：

- 投递目录：`%LOCALAPPDATA%\AgentHUD\events\drop\<id>.json`（32 位 hex id）
- 响应目录：`%LOCALAPPDATA%\AgentHUD\events\resp\<id>.json`
- confirm 请求 schema：`{id, app:'dsh', kind:'confirm', title, body, buttons:['允许','拒绝'], timeout, created}`
- notify 请求 schema（v0.2.0）：`{id, app:'dsh', kind:'notify', title, body, timeout, created}`（无 buttons、不写 resp，消费后即删）
- 响应 schema：`{id, button:'允许'|'拒绝'|null, timeout:boolean}`（无 BOM 原子写）
- 监听要求：FSW 必须同时覆盖 `Created` + `Renamed` 事件（请求是同目录 rename 落地的，只挂 `Created` 会全盲）+ 启动扫描

完整协议契约、双侧职责与联调判据见 [HANDOFF-HUD.md](HANDOFF-HUD.md)。其他桌面通知前端想接入 DSH 审批流，实现同一协议即可。

## 设置

在 DSH 设置页（或 `~/.dsh/plugin-data/dsh-agent-hud/settings.json`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（关闭后插件完全旁路） |
| `questionNotify` | `true` | DSH 提问时弹 HUD 提醒气泡 |
| `turnNotify` | `true` | agent 回合结束时弹 HUD 提醒气泡 |
| `timeoutSec` | `110` | 等待 HUD 决策的超时秒数 |
| `pollMs` | `200` | 响应文件轮询间隔 |
| `logMax` | `200` | 决策日志保留条数 |

> notify 气泡停留时长内置于代码、非配置项：提问提醒 **20 秒**、任务回合完成 **15 秒**（`lib/index.js` 里 `notifyFire` 调用的 `timeoutSec` 常量，修改后需重启 DSH 生效）。

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
node scripts/host-unit-test.mjs         # host 行为测试（52 项）
node scripts/hud-ping.mjs               # 端到端连通性测试（需 HUD 运行，30 秒窗口）
```

架构、内核契约出处与装配 SOP 见 [agent.md](agent.md)。

## License

[MIT](LICENSE)
