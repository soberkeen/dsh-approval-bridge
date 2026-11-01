# agent.md — @dsh-external/dsh-agent-hud 项目索引

> 给后续 agent 会话的导航文档。读完本文件即可定位一切细节，不必重新侦察内核。

## 这是什么

DSH 原生 cordis 插件（v0.2.0）：三种 agent 运行期事件桥接到本地 **Agent HUD** 桌面侧边栏。

| 事件 | 内核事件 | HUD 形态 | 语义 |
|---|---|---|---|
| 权限确认 | `approval/request` | confirm 气泡（允许/拒绝按钮） | **并行平级、先到先得**：原生卡片与 HUD 气泡同时弹出，在哪边裁决都生效，另一边作废收摊；原生 unavailable 时 HUD 独立裁决；HUD 超时按拒绝（fail-closed） |
| DSH 提问 | `user-questions/request` | notify 提醒气泡（无按钮） | **纯提醒**（用户定稿 m00912）：只告知「DSH 在提问」，作答仍走原生问答卡片；观察者模式无条件 `next()` 透传，绝不 claim |
| 任务回合完成 | `agent/turn-stopping` | notify 提醒气泡（无按钮） | 每个 agent 回合结束时投递（用户拍板「每回合都发」） |

- 需求文档：`<需求文档目录>\DSH-插件需求.md`（只定义 confirm 协议；提问/任务完成为 v0.2.0 口头需求）
- 用户决策（已定，勿重问）：①审批**并行平级、先到先得**（非兜底；原生 unavailable 时 HUD 独立裁决）；②要 **client 设置分区**；③提问只提醒不作答；④任务完成每回合都发；⑤提问/任务完成两个通知各有独立开关（`questionNotify`/`turnNotify`，默认开）。
- 语义约束：approval waterfall 全链只传 outcome 字符串（`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`），**无法附自定义 reason**——「HUD 未响应」等精确原因写进决策日志 `decisions.jsonl`，内核侧只能拿到标准文案。
- 已知体验瑕疵（协议限制）：HUD 先点时，DSH 原生卡片要等用户再点一下才消失（waterfall 无取消机制，弃权返回值无人消费）；HUD 后点时其气泡靠自身倒计时收摊。

## 目录地图

| 路径 | 职责 |
|---|---|
| `package.json` | `dsh.bundle.patch` → `cordis.patch.yml`；`dsh.client`（web 平台，依赖 slots+locale）；exports `./client` |
| `cordis.patch.yml` | 插件树插入声明 `- insert: [{id: dsh-agent-hud, name: '@dsh-external/dsh-agent-hud'}]`。**空列表 = host+client 一起静默缺席** |
| `lib/index.js` | host 入口。`apply(ctx)`：启动清理孤儿请求 → ①`ctx.on('approval/request')` **并行平级 answerer**（deliverRequest 立即投递 HUD → `next()` 与 HUD 等待 `Promise.race` 先到先得；原生 unavailable ≠ 收摊信号，HUD 继续独立裁决）②`ctx.on('user-questions/request')` 观察者（notifyFire 提醒 → 无条件 `return next()` 透传）③`ctx.on('agent/turn-stopping')`（notifyFire 提醒）→ notifyTimers 延迟清理（60s 兜底删 notify drop，ctx.effect 挂 disposer）→ 可选挂 webServer API（10 次重试轮询，缺服务降级） |
| `lib/hud.js` | HUD 文件协议层。confirm 侧：`deliverRequest`（非阻塞投递）+ `waitForDecision`（阻塞轮询：默认 200ms、超时 110s、signal 中止、半截文件容错、贴边 final poll）；`askHud` = 两者组合（/test 用）；`buildRequest/parseResponse`。notify 侧（v0.2.0）：`buildNotifyRequest`（kind:'notify'、无 buttons、timeout 下限 3s）+ `deliverNotify`（fire-and-forget 投递）。共用：`atomicWriteJson`（临时文件+rename）、`cleanupRequest/cleanupRequestRetrying`、`sweepOrphans`（只清 `app==='dsh' && kind==='confirm'` 残留） |
| `lib/settings.js` | 设置与决策日志。状态目录 `~/.dsh/plugin-data/dsh-agent-hud/`；`DEFAULTS {enabled:true, questionNotify:true, turnNotify:true, timeoutSec:110, pollMs:200, logMax:200}`；`SETTABLE` 白名单（越界/非数拒收）；`decisions.jsonl` 尾读（新的在前） |
| `lib/server.js` | webServer API：前缀 `/@dsh-external/dsh-agent-hud/api`，端点 `/health` `/settings`(GET/POST) `/decisions` `/clear-log` `/test` `/sweep` |
| `lib/client.js` | client bundle。`window.__ModuleLoader__.load({id, factory})` 包装；注册 `settings.section`（id `dsh-agent-hud-settings`，order 61）；React 仅作壳，UI 纯 DOM；CSS 模板串**不得含裸反引号** |
| `scripts/client-register-test.mjs` | client 半边契约测试（mock React/ctx，验证 ModuleLoader 物化 + section 注册），**10/10 绿** |
| `scripts/host-unit-test.mjs` | host 半边行为测试（协议/超时/中止/清理/设置白名单/日志/race 6 场景/notify 协议/提问透传/turn-stopping/开关矩阵），**52/52 绿** |
| `scripts/sync-to-plugin-dir.mjs` | 同步到运行副本 `%USERPROFILE%\.dsh\plugins-desk-v1\@dsh-external\dsh-agent-hud\`（源目录含中文路径不能 junction，用复制；`--dry-run` 预览） |
| `.gitignore` | 排除 `node_modules/ .ref/ .log/ .tmp/`（`.ref` 是 100MB+ 内核解包，绝不进 git） |
| `.ref/` | 只读参考资料：`asar-full\dsh\`（内核全量解包）、`hooks-claude-code\`、`asar-tool\`。**参考用，不构建、不发布** |

## 内核契约（侦察结论，含出处）

- **approval 服务**：`app.asar.unpacked\dsh\node_modules\@deepseek-ai\dsh-user-approval\lib\index.js` — ApprovalService `request(req)` → `decide()` → `ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, () => Promise.resolve('unavailable'))`。
- **并行 answerer 模式**（已定稿）：`ctx.on('approval/request', async (req, next) => { 投递 HUD（不等待）→ Promise.race([next() promise, HUD 等待 promise]) → 先到先得 })`。原生 `unavailable`（无渠道）≠ 收摊信号，HUD 继续独立裁决。插件在启动期 apply，先于 remote 桥 / ACP 的运行期注册（先注册 = waterfall 外层），天然位于最外层。先例：`dsh-acp\lib\index.js:1158`（根 ctx 注册可收 agent scope waterfall）。
- **cordis waterfall**：`.ref\asar-full\dsh\node_modules\@deepseek-ai\cordis\lib\index.js:317-325` — 监听器按注册顺序组洋葱链，`next()` 弹下一个，最外层返回值为最终结果。
- **并行裁决模式**：answerer 收到请求 → `deliverRequest` 立即投递（HUD 与原生卡片同时出现）→ `next()` 不先 await，其 promise 与 `waitForDecision` 做 `Promise.race` → 先到者赢。**关键**：原生链返回 `unavailable`（无渠道）时不 abort HUD（继续独立裁决）；只有真裁决才收摊。收摊时 `ac.abort()` + 两侧 promise `.catch(()=>{})` 防 unhandled rejection。
- **outcome 映射**（`dsh-tools\lib\index.js:3535-3551`）：allowed-once→allow；rejected→deny（`the user rejected tool "<name>"`）；cancelled→deny；unavailable→deny（`requires approval, but no approval channel is available`）。
- **HUD 文件协议**（HUD 侧已实现，不可改）：drop `%LOCALAPPDATA%\AgentHUD\events\drop\<id>.json`（请求），resp `...\resp\<id>.json`（响应）。confirm 请求 `{id:32hex, app:'dsh', kind:'confirm', title, body, buttons:['允许','拒绝'], timeout, created}`；响应 `{id, button:'允许'|'拒绝'|null, timeout:boolean}`。映射：允许→`'allowed-once'`；拒绝/超时→`'rejected'`；中止→`'cancelled'`。notify 请求（v0.2.0）：`{id, app:'dsh', kind:'notify', title, body, timeout, created}`（无 buttons）——HUD 无按钮气泡、按自身 `_life` 收摊、消费后**立即删 drop 文件**、不写 resp；HUD 未运行时残留由插件 60s 延迟清理兜底。
- **user-questions 服务（rc.4 新增）**：`ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', {...request, agent}, noAnswerer)`；noAnswerer = reject `UserQuestionError('no user-questions answerer accepted the request', 'NO_PROVIDER')`——waterfall 上任何 answerer **必须 claim 或调 next()**，直接返回 undefined 会让上游拿到非 answer 结果。请求类型 `AskUserQuestionRequestEvent = {questions: AskUserQuestionItem[], agent?, signal?, wait?: {callId, timed?}}`；item `{id, question, detail?, header?, options?, multiSelect?, intent?}`（运行内核 app.asar 文本 :1787215/:1787203 declaration）。本插件是纯观察者：投 notify 后 `return next()`。
- **agent/turn-stopping（rc.4 实证）**：`await this.dispatch.serial("agent/turn-stopping", {turn, signal, agent})`。serial = fire-and-forget 顺序调用（监听器无 next、返回值被忽略）；payload **含 agent**（app.asar generated region 签名 `this: Scoped<Agent>`；早期侦察「payload 无 agent」是误读）；dispatch 时 signal 必然未中止（调用点前置 `throwIfAborted` 把关）；scope-filtered dispatch 下根 ctx 全局注册可达（官方先例 `ctx.on("agent/turn-stopping", async ({agent, turn}) => ...)`），实测 `任务完成提醒已投 HUD（turn=13）` 落日志 ✓。
- **webServer**：`webServer.register({kind:'prefix', path, handler})`（契约见 `dsh-host-webserver\lib\index.js:326`）；handler 收完整 req/res，自剥前缀；重复 (kind,path) throw。
- **client 注册**：`ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section', id, order, label, locale}, React组件))`。

## 常用命令

```powershell
node --check lib/index.js        # 语法（不算验证）
node scripts/client-register-test.mjs   # client 契约 10/10
node scripts/host-unit-test.mjs         # host 行为 52/52
node scripts/sync-to-plugin-dir.mjs --dry-run   # 同步预览
node scripts/sync-to-plugin-dir.mjs       # 同步到运行副本
```

装配 desktop profile：见下方「装配安全（与插件市场共存）」SOP。

## 装配安全（与插件市场共存）——20261029 内核定案

**结论：按 SOP 装配，市场升级不受任何影响；反之手塞/手改 profile 文件正是历史踩坑根源。**

市场升级全链路（证据齐全）：
- 市场 UI 只做目录索引与版本比较（`dsh-plugin-market\lib\index.js:642` `update-available` 标记），实际升级全部走 plugin-manager。
- 升级 = `installBundle(spec)`（`dsh-plugin-manager\lib\index.js`）→ profile 目录内 `pnpm add` → 兼容性校验（engines/peerDependencies）失败时回滚 `RESTORED_FILES = ["package.json", "pnpm-lock.yaml"]` 并重装 node_modules（:742-758、:1293）→ 成功后 `reconcile`（:322-351）**只增删 `dsh.profile.bundles` 数组**。
- 全程**不碰**：①node_modules 之外的任何目录（plugins-desk-v1 源目录安然无恙）②`link:` 依赖（pnpm 一等公民，lockfile 登记，junction 形态）③profile `cordis.patch.yml` 用户层内容（插件开关只改末条匹配覆盖项的 `disabled`；官方保证用户层跨升级存活）。
- 每个 bundle 的 patch 来自包内 `dsh.bundle.patch` 声明文件——bundle 层与用户层（profile cordis.patch.yml）是分开的层，升级只重排 bundle 依赖本身。

历史踩坑模式（本项目规避对照）：
| 坑（用户多次踩过） | 本项目规避 |
|---|---|
| 插件文件夹直接塞进 profile `node_modules`（不在 lockfile）→ pnpm 重排时被清/幽灵 | 源目录在 `plugins-desk-v1`（pnpm 管辖外）；node_modules 里只有 lockfile 登记的 junction |
| 手改 profile `cordis.patch.yml` 加 insert | 本插件 patch 走包内 `cordis.patch.yml`（`dsh.bundle.patch` 声明），从不手写 profile patch |
| 手改 profile `package.json` 不跑 pnpm → lockfile 失配 → 下次市场升级 `--frozen-lockfile` 失败整体回滚 | 装配走官方 `dsh plugin install`（它自己写 package.json + pnpm + reconcile） |
| link 源目录被 git clean 等清掉 → junction 断头装载失败 | 源是 `plugins-desk-v1` 独立副本（sync 脚本维护），不在 git 工作区 |

装配 SOP（**已实装 ✅ 20261029**，实测记录）：
1. `node scripts/sync-to-plugin-dir.mjs`（工作区 → plugins-desk-v1 运行副本）✅
2. 官方 CLI 装入（**实测可对运行中的 desktop profile 直接执行，无需先退出 DSH**）：`<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add %USERPROFILE%//.dsh/plugins-desk-v1/@dsh-external/dsh-agent-hud`（绝对路径 spec；`dsh plugin` = pnpm 转发 + reconcile，写入锁 `withFileLock(package.json)` 只在包操作瞬间持有）。**绝不手写 profile 的 package.json / cordis.patch.yml / 跑裸 pnpm**（官方 skill 明令禁止，`dsh-agent-preset\skills\cordis-plugin-development\SKILL.md:10`）。⚠️ pnpm add 会顺带同步 manifest↔lockfile 的历史漂移（本次顺带修了 billion-context 0.1.208→0.209），属正常修复。
3. 验证五点（本次 1-3 已验证 ✅）：profile `package.json` 出现 `"@dsh-external/dsh-agent-hud": "link:..."` 且 `dsh.profile.bundles` 末尾追加（本次第 21 位）；`node_modules\@dsh-external\dsh-agent-hud` junction 指向 plugins-desk-v1 ✅；包内 cordis.patch.yml 可达 ✅；GUI 插件管理页列表正常；设置页出现「Agent HUD 审批桥」分区（启动图判据 `GET http://127.0.0.1:19387/plugins/??@dsh-external/dsh-agent-hud/client.js&rev=<sha1前12位>`，rev 变了 = 新代码已装载）；随便升级一个市场包成功且本插件仍在。
4. peerDependencies 警告（react/react-dom/dsh-client-ui-slots/dsh-client-locale）**无害**：client bundle 依赖由宿主运行时注入，不走 node_modules 解析，与 dsh-vault 同形态。

干扰面自查（本插件对市场零干扰）：包名 `@dsh-external/dsh-agent-hud` 与市场无重名；webServer 前缀路径唯一；settings.section id 独立；approval/request 链参与与包管理无关；无 postinstall/构建脚本。

## 已知坑（实测）

1. `cordis.patch.yml` 空列表 → host+client 一起静默缺席，日志无报错。
2. client.js 顶层模板串里的裸反引号会提前终结字符串 → factory 物化抛 ReferenceError（契约测试断言 0 专门抓这个）。
3. asar 的 `extractAll/extractFile` API 在 DSH asar 上路径解析不可靠；`npx asar extract` 全量解包 100% 可靠。
4. 源目录含中文路径 → 不能做 junction，同步脚本用复制。
5. `askHud` 等待时长用调用方原始 `timeoutSec`（下限 1s）；协议字段 `timeout`（HUD 倒计时）单独钳 ≥5s，两者勿混用（host-unit-test 曾抓到 1s 配置实际等 5s 的 bug）。
6. race 收摊时机：原生链返回 `unavailable` 表示「无渠道」而非「已裁决」，此时 abort HUD 会把接管误杀成 `cancelled`（实测抓过）——只有非 unavailable 的原生裁决才 abort。
7. race 收摊后必须对两侧 promise `.catch(() => {})`，否则败方 reject 时 unhandledRejection。
8. `user-questions/request` waterfall 上的观察者**必须** `return next()`：不调 next 直接返回 undefined 会让内核拿到非 answer 结果；无人应答时 noAnswerer 抛 `NO_PROVIDER`——只提醒不 claim 的实现里「透传」是唯一正确姿势。
9. notify 与 confirm 的 drop 清理责任不同：HUD 消费 notify 后自己删文件（即删语义），confirm 文件则保留（dropWatch 收摊信号依赖存活）——所以 sweepOrphans 只清 confirm，notify 残留靠插件 60s 延迟清理 + HUD 10 分钟兜底。
