# HANDOFF-HUD.md — DSH ↔ Agent HUD 对接交接（给 HUD 侧 agent）

> **配套项目**：[Agent HUD](https://github.com/soberkeen/agent-hud)——本插件（`@dsh-external/dsh-agent-hud`）是
> Agent HUD 的 **DSH 通知适配辅助插件**，HUD 主程序仓库见上方链接。两侧通过文件协议对接，协议契约见 §2。

> 交接方向：DSH 插件侧（`@dsh-external/dsh-agent-hud`）**已开发完成并实装**，本文写给负责
> Agent HUD 桌面端的 agent，处理 HUD 侧对 DSH 审批桥的接入。读完本文即可动手，
> 不需要读 DSH 插件源码（但文末有路径速查，需要细节时可查）。

## 0. 一句话背景

DSH（DeepSeek Harness 桌面端）的 agent 运行时会发起**工具权限确认**。DSH 侧插件已把
这些确认请求**同时**投递到：① DSH 原生审批卡片；② Agent HUD（文件协议）。
**双方平级、先到先得**——用户在 HUD 点「允许/拒绝」与在 DSH 卡片点效果完全相同。

**v0.2.0（2026-11-01）新增两种纯提醒**（fire-and-forget，不等待、无按钮、无需操作）：
①DSH 发起提问（`user-questions/request`）→ HUD notify 气泡「DSH 提问：…」；
②agent 回合结束（`agent/turn-stopping`）→ HUD notify 气泡「DSH 任务回合完成」。
协议见 §2 notify 请求段；HUD 侧 notify 已原生支持，预期零变更。

## 1. 已定稿语义（DSH 侧行为，HUD 侧按此适配，勿假设兜底模式）

| 行为 | DSH 侧实现 | HUD 侧需要知道的 |
|---|---|---|
| 投递时机 | 审批请求到达的**瞬间**写 drop 文件 | 气泡出现即代表一个真实待决审批 |
| 并行裁决 | HUD 与原生卡片同时等待，`Promise.race` 先到先得 | 用户在任一边点都生效；另一边作废 |
| 插件等待超时 | 默认 **110 秒**（请求 `timeout` 字段同值）→ 按拒绝处理 | HUD 倒计时归零必须自己收摊（见 §3.3） |
| 响应读取 | 插件每 **200ms** 轮询 resp 目录 | resp 写入后最多 200ms 被消费 |
| 请求作废 | 原生渠道先裁决 / agent 取消 → 插件**删除两侧文件**并退出等待 | 文件消失 ≠ HUD 必须立即收摊（见 §3.4 体验瑕疵） |
| HUD 未运行 | 插件超时后按拒绝处理（fail-closed） | 无需心跳/存活协议 |

## 2. 文件协议（**契约，不可单方变更**）

目录（`%LOCALAPPDATA%` = `C:\Users\<user>\AppData\Local`）：

```
%LOCALAPPDATA%\AgentHUD\events\drop\   ← DSH 插件写请求，HUD 读
%LOCALAPPDATA%\AgentHUD\events\resp\   ← HUD 写响应，DSH 插件读
```

请求（drop）：`<id>.json`，`<id>` 为 **32 位小写 hex**（16 字节随机，全局唯一）：

```json
{
  "id": "a1b2c3…(32hex)",
  "app": "dsh",
  "kind": "confirm",
  "title": "DSH 权限确认 · <工具名>",
  "body": "工具「xxx」请求执行许可：\n<原因>\n\n允许 / 拒绝（110 秒未响应将自动拒绝）",
  "buttons": ["允许", "拒绝"],
  "timeout": 110,
  "created": 1730000000
}
```

- `app`：来源应用标识。**HUD 必须按 `app === 'dsh'` 过滤**——drop 目录是多应用共享的。
- `kind`：`"confirm"`（带按钮审批）或 `"notify"`（v0.2.0 纯提醒，无按钮）；HUD 对未知 kind 应忽略（向前兼容）。
- `timeout`：单位**秒**，HUD 倒计时用它（DSH 侧 confirm 钳制 ≥5，notify 钳制 ≥3；实际配置下限也是 5）。
- `created`：unix 秒，可用于排序/清理判断。
- **按钮字面量是协议的一部分**：`buttons[0]` 恒为 `"允许"`、`buttons[1]` 恒为 `"拒绝"`。
  HUD 渲染可用 `buttons` 数组本身，但响应必须回写其中之一的**原文**。

notify 请求（v0.2.0，无 buttons 字段、不写 resp）：

```json
{
  "id": "a1b2c3…(32hex)",
  "app": "dsh",
  "kind": "notify",
  "title": "DSH 提问 / DSH 任务回合完成",
  "body": "…提醒文案…",
  "timeout": 8,
  "created": 1730000000
}
```

- HUD 侧已有 notify 气泡语义（无按钮行、`_life` 定时收摊、消费后立即删 drop、不写 resp）——DSH 侧按此协议投递，**零变更**。
- DSH 侧对 notify 不等待响应：投递即忘；60 秒后插件会尝试清理残留 drop 文件（HUD 正常消费时文件已被删，清理静默跳过）。

响应（resp）：同名 `<id>.json`：

```json
{ "id": "<同请求 id>", "button": "允许" }      // 用户点允许
{ "id": "<同请求 id>", "button": "拒绝" }      // 用户点拒绝
{ "id": "<同请求 id>", "button": null, "timeout": true }  // HUD 侧倒计时归零（可选，见 §3.3）
```

DSH 侧解析规则（`parseResponse`）：`button === "允许"` → 放行；`button === "拒绝"` → 拒绝；
`button` 非法但 `timeout === true` → 拒绝；其余（含半截/损坏 JSON）→ 视为未就绪，继续等。

**写入方式硬要求（两侧都是）**：临时文件 + rename（同盘 rename 原子）。
DSH 侧实现：先写 `<file>.<pid>.tmp` 再 `renameSync`。HUD 侧必须同款——否则插件 200ms
轮询可能读到半截 JSON（虽然容错不崩，但会浪费轮次、制造无谓延迟）。

> ⚠️ **HUD 侧监听实现警告（联调实测踩过，见 §4.4）**：DSH 的原子写是**同目录
> rename**——.NET `FileSystemWatcher` 对同目录 rename 触发的是 **`Renamed` 事件，
> 不是 `Created`**。只挂 `Created` 处理器的 FSW **永远收不到 DSH 的实时请求**
> （且 `.tmp` 中间名不匹配 `*.json` filter，写 tmp 阶段也无事件）。监听必须
> 同时覆盖：`Created`（外部直接写入，如手工测试）+ `Renamed`（DSH 标准协议）+
> 启动扫描（readdir 捡重启前落地的旧文件）。三者缺一都有断链窗口。

## 3. HUD 侧职责清单

### 3.1 必须

1. **监听 drop 目录**：FSW 需同时处理 `Created` + `Renamed` 事件并做启动扫描
   （原因见 §2 末尾警告与 §4.4），或直接用低频轮询（每 2 秒 readdir，成本极低）。
   发现 `app === 'dsh' && kind === 'confirm'` 的新请求 → 渲染气泡。
2. **按 `timeout` 秒倒计时**；期间展示 `title` / `body` / 两个按钮。
3. **用户点击 → 原子写 resp**（§2 响应格式）。写完 resp 后可立即收摊气泡
   （插件 200ms 内会来读并删除两侧文件）。
4. **倒计时归零 → 自己收摊气泡**。推荐同时写 `{id, button:null, timeout:true}` 响应
   （让 DSH 侧立即拿到明确信号、记录精确日志）；不写也可以——DSH 侧到点按超时拒绝。
5. **支持并发多请求**：每个请求独立 `<id>`，可能同时挂多个气泡（多 agent 并行时）。
   同名文件 id 唯一不会互相覆盖。
6. **只消费 `app === 'dsh'` 的请求**；其他应用的请求按 HUD 自己的多应用逻辑处理，
   不要动它们的文件。

### 3.2 建议

- **写 resp 前先检查气泡是否还该写**：若用户长时间不点而气泡仍在倒计时，正常；
  若气泡已因用户点击写完 resp，不要重复写。
- **resp 目录自清理**：极端时序下（DSH 侧已放弃等待并删文件之后，HUD 才写 resp）
  resp 会留下无人认领的 `<id>.json` 残留（id 唯一，不会被复用误读）。
  建议 HUD 启动时清理 resp 目录中 `created`/修改时间超过 10 分钟的文件
  （只清自己写的、能解析出 id 的；不认识的文件别动）。
- **drop 目录不要主动清理**：DSH 插件启动时会 sweep 掉 `app === 'dsh'` 的孤儿
  （崩溃残留），清理权在 DSH 侧。

### 3.3 双侧超时赛跑（重要）

DSH 侧 deadline 与请求 `timeout` 字段同值（默认 110s，下限 5s，上限 600s，可在设置改）。
两侧时钟独立（都从各自「看到请求」起算，误差 ≤ 文件投递延迟），所以：

- HUD 倒计时先归零 → 写 `timeout:true` 响应 → DSH 侧读到按拒绝处理；
- DSH 侧 deadline 先到 → 删两侧文件、按拒绝处理 → HUD 稍后倒计时归零自己收摊即可，
  写 resp 也没人读（残留见 §3.2 建议清理）。

**HUD 不要把倒计时设得比请求 `timeout` 更长**——那会让用户体验与 DSH 日志不一致。

### 3.4 已知体验瑕疵（协议限制，已记录在案，HUD 侧能优化一半）

- **DSH 原生先裁决**：插件删除 drop/resp 文件，但**没有撤回消息**——HUD 气泡只能
  等自己倒计时归零收摊（最长残留 `timeout` 秒的「僵尸气泡」）。
  **HUD 侧可优化**：气泡渲染期间顺手 watch 自己那条 drop 文件——文件被删 = 对方已收走
  → 提前收摊气泡。这是纯优化，不做也不出错（倒计时兜底）。
- **HUD 先点**：DSH 原生卡片要等用户在原生 UI 再点一下才消失（DSH waterfall 无取消
  机制，DSH 侧无法优化）。HUD 侧无事可做。

## 4. 联调与验证

### 4.1 连通性测试（不用真实审批）

DSH 设置页 →「Agent HUD 审批桥」分区 → 状态标签 → **「测试 HUD」按钮**：
发出一条 `title: "HUD 连通性测试"` 的请求（20 秒窗口）。HUD 弹气泡 → 点「允许」→
设置页应出现放行记录；不响应 → 按钮报「无响应」。

也可以直接打 API（DSH webServer 前缀路由）：

```
POST http://127.0.0.1:<port>/@dsh-external/dsh-agent-hud/api/test
GET  …/api/health        GET …/api/settings
GET  …/api/decisions?limit=20    POST …/api/clear-log    POST …/api/sweep
```

### 4.2 真实审批联调

1. 让 DSH agent 跑一个需要审批的工具（如 `pwsh` 写操作）。
2. 预期：**DSH 原生卡片与 HUD 气泡同时出现**（并行平级的核心验收点）。
3. 在 HUD 点「允许」→ 工具继续执行；DSH 设置页日志出现 `source: "hud"`、
   `outcome: "allowed-once"` 的记录。
4. 再来一次，在 DSH 原生卡片点 → HUD 气泡作废（`source: "native"`）。
5. 第三次，两边都不点 → 110 秒后工具被拒，日志 `detail` 含「HUD 未响应」。

### 4.3 DSH 侧健康判据

- 插件已实装 desktop profile（`dsh.profile.bundles` 含 `@dsh-external/dsh-agent-hud`，
  junction → `%USERPROFILE%\.dsh\<插件源目录>\@dsh-external\dsh-agent-hud\`）。
- client 启动图：`GET http://127.0.0.1:19387/plugins/??@dsh-external/dsh-agent-hud/client.js`
  返回 JS 即装配成功。
- DSH 状态目录：`~/.dsh/plugin-data/dsh-agent-hud/`（`settings.json` + `decisions.jsonl`）。

### 4.4 联调实录（2026-11-01）：四轮实验定位 → HUD v2.9.4 四断点全修 → 链路全通 ✅

**排查期证据**（DSH 侧用 `.tmp/hud-ping.mjs` / `.tmp/hud-trace*.mjs` 发真实协议请求，
逐秒观测 drop/resp 文件流向，结合用户目视确认气泡）：

| # | 写入方式 | FSW 消费 | resp 回写 | 气泡 |
|---|---|---|---|---|
| 1-2 | tmp+rename（**DSH 标准协议**） | ❌ 文件 15-30s 无人动 | — | — |
| 3-4 | writeFileSync 直接写 | ✅ 1s 消费 | ❌ 30s 从不出现 | ❌ 用户确认没弹 |

**断点 1 —— FSW 收不到标准协议写入 ✅ 已修（HUD v2.9.4）**
- 根因：DSH 原子写 = 同目录 rename → FSW 触发 `Renamed` 而非 `Created`；只挂 Created 收不到。
- 修复：去掉 filter，`Created`+`Renamed`+`Changed` 三事件全挂统一 `QueueEventFile`
  按扩展名分拣（`.tmp` 天然被过滤），启动扫描保留。Dbg 日志实证
  `FSW Renamed → consume drop → HandleEventFile shown ok`。

**断点 2 —— 消费后不渲染、不回写 ✅ 已修（HUD v2.9.4，双根因叠加）**
- 根因 A：v2.9.2 气泡自适应重构时 `NotifyBubble.OpenAt` 的 `Popup.IsOpen = true;`
  被补丁脚本吞行——气泡从未弹出（实验 3-4 的全部假象由此而来）。
- 根因 B：先删后验空读竞态——`Created` 事件早于 writer 完成，读到空/半截照样删文件。
- 修复：读+解析一体重试（8×150ms），解析成功才删；放弃时保留文件等下一事件。

**断点 3 —— resp BOM ✅ 已修（HUD v2.9.4，DSH 侧同步加固）**
- 根因：HUD 旧 `WriteResponse` 用带 BOM 的 UTF-8，Node `JSON.parse` 遇 `\uFEFF` 抛错
  → resp 永远「未就绪」直到超时。HUD 已改无 BOM 写出；DSH 侧 `readJsonSafe`
  亦已加剥 BOM 防御（带测试用例，host-unit-test 32/32）。

**断点 4 —— 气泡定位回归 ✅ 已修（HUD v2.9.4）：OpenAt 两分支偏移写反致气泡盖住
HUD 面板，已修正（气泡贴 HUD 外侧、尾巴指向角色）。

**最终验证（2026-11-01）**：
```
node scripts/hud-ping.mjs
→ {"ok":true,"decision":"allow","elapsedMs":25247}   # v2.9.4 时期，人工点击，全链路通
→ {"ok":true,"decision":"allow","elapsedMs":1429}    # v2.9.5 时期，收摊无闪退 ✅
```
drop/resp 双空；HUD 重启后启动扫描正常。**剩余验收**：真实审批三连测（§4.2），
需在 DSH 真实 agent 会话里走一遍 allow / deny / 超时。

**DSH 侧后续加固（commit 5f17187 + ac16bcb，实测抓到）**：
1. `readJsonSafe` 剥 BOM 防御——对齐 HANDOFF-DSH §1 断点 3 建议，带测试用例。
2. 贴边 final poll——HUD 倒计时归零写 timeout resp 的时刻 ≈ DSH deadline + 写盘延迟
   （实测差 36ms 漏读），等待循环退出后补读一次，timeout resp 不再被错过。
3. `cleanupRequestRetrying`——杀毒/索引器短暂锁文件导致 unlink EPERM 时（实测残留过
   一个 resp），每 200ms 重试最多 10 次，彻底失败 warn。drop/resp 残留不再依赖
   HUD 10 分钟兜底。

### 4.5 联调实录（2026-11-01）：「显示回归」实为观察窗口误报 —— 真 bug 是 HUD notify 硬编码 8 秒收摊 ✅ 已修（v2.9.7）

> **最终结论（HUD 侧回执，见 HANDOFF-DSH.md §6）**：显示链从未损坏。confirm（110s
> 真实参数）与 notify（timeout=60）在 -dbg 日志（`Renamed → consume → shown ok`）
> + 目视确认下全部正常弹出。下面两条「没弹」均为 notify：HUD 旧实现把 notify 收摊
> **硬编码 8 秒**（无视请求 `timeout` 字段，违反协议 §2——DSH v0.2.0 notify
> timeout=8 的数字巧合掩盖了违规），且两次投递时用户视线都在 DSH 侧，8 秒瞬态
> 必然错过。「confirm 零气泡」行无文件证据、实测不复现。
> **HUD v2.9.7 修复**：notify 按请求 timeout 倒计时（钳 ≥3s）。
> **DSH 侧跟进**：提问提醒 timeout 10→**20s**、回合完成 8→**15s**（采纳 HANDOFF-DSH
> §6 的 15-30s 建议）。以下排查过程存档。

**当时的误报现象**（DSH v0.2.0 三种通知实测，用户重启 DSH 14:28 后）：

| 实验 | 时间（本地） | drop 文件 | 气泡 |
|---|---|---|---|
| 插件真实提问 → notify「DSH 提问」×1 | 14:29:32 | 已消失 | ❌ 用户确认没弹 |
| 手动投递 notify 样本（kind:notify） | 14:33:15 | **2 秒被删** | ❌ 没弹 |
| confirm 审批链路 | — | — | ❌ 零气泡 |
| 上一个进程（v2.9.5 时期） | 昨天～今天上午 | 正常 | ✅ 正常弹 |

- 用户证词：**「之前审批测试是正常弹，现在我没见过任何气泡」**——v2.9.5 正常，
  当前 2.9.6.0 实例（agent-hud PID 133312，14:10:18 启动，单实例，Responding=True）
  **消费链活着（文件 2s 即删）但显示链全断**。
- exe 已升级：`agent-hud.exe` FileVersion **2.9.6.0**（联调时为 2.9.5.0）。

**旁证**（HUD 侧取证线索）：
1. `crash.log` 尾部 13:30:43：`ButtonBase.OnClick → …` 堆栈（v2.9.5 末期 UI 异常，
   可能催生 2.9.6 发布，也可能与本次回归同源）。
2. `decisions.jsonl` 尾条 `04:28:54Z`（本地 12:28）probe **hud-timeout**——
   v2.9.5 末期 HUD 已 20 秒无响应，异常可能早于 2.9.6 部署。
3. `anim-err.log` 停在昨晚 23:18——14:10 启动的实例**没带 -dbg**，无调试日志可查；
   复现时请带 `-dbg` 并检查 `shown ok` 是否仍出现在 Dbg 日志（若日志说 shown 而肉眼
   不可见，问题在气泡渲染/定位/收摊路径，而非消费路径）。

**验收结果：全部通过 ✅**（2026-11-01 15:00 最终复测，HUD v2.9.7 + 插件 timeout 20s/15s）

| # | 测试 | 落盘证据 | 目视 |
|---|---|---|---|
| ① | confirm 连通性 | `06:59:22Z hud-allow（允许，1433ms）source:probe`（decisions.jsonl） | ✅ 卡片+按钮弹出，点击后收摊，测试成功 |
| ② | 提问提醒 notify | `06:57:31Z 提问提醒已投 HUD（2 问）`（desktop-next.log） | ✅ 气泡挂满 20 秒自动收摊 |
| ③ | 回合完成 notify | `06:58:39Z 任务完成提醒已投 HUD（turn=16）` | ✅ 气泡弹出 |

①②③ = HANDOFF-DSH §6 中 HUD agent 的实弹验收；④ = 本次 DSH 侧三种通知目视复测。
turn-stopping serial 事件每回合触发（`turn=13`/`turn=16` 均落日志）✓。
HUD 侧无需再改；插件侧无遗留缺陷。

## 5. 变更流程约定

- 文件协议 schema / 按钮字面量 / 目录布局是**双侧契约**：任何一方要改，
  先改需求文档 `<需求文档目录>\DSH-插件需求.md`，两侧同步后再动代码。
- DSH 侧代码改动：改工作区 `<插件工作区>\` → `node scripts/host-unit-test.mjs`
  （57/57）+ `node scripts/client-register-test.mjs`（10/10）→
  `node scripts/sync-to-plugin-dir.mjs` 同步到运行副本 → 重启 DSH。
- HUD 侧只动 `%LOCALAPPDATA%\AgentHUD\` 相关逻辑，**不要**碰 DSH profile /
  <插件源目录> / DSH 设置。

## 6. 路径速查

| 项 | 路径 |
|---|---|
| DSH 插件工作区（源码） | `<插件工作区>\` |
| 协议层实现（参考读） | `lib/hud.js`（协议、原子写、轮询、清理） |
| 审批桥主逻辑（参考读） | `lib/index.js`（并行 race 应答器） |
| 运行副本（DSH 实际加载） | `%USERPROFILE%\.dsh\<插件源目录>\@dsh-external\dsh-agent-hud\` |
| DSH 设置/日志 | `%USERPROFILE%\.dsh\plugin-data\dsh-agent-hud\` |
| HUD 协议目录 | `%LOCALAPPDATA%\AgentHUD\events\{drop,resp}\` |
| 需求文档 | `<需求文档目录>\DSH-插件需求.md` |
| 项目索引（DSH 侧全景） | `<插件工作区>\agent.md` |
