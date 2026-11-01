// lib/client.js — dsh-agent-hud client 半边：settings.section 面板（纯 DOM，零构建）
//
// 形态照抄本机既有实现（dsh-vault/lib/client.js 与 dsh-plugin-dev-guard skill §3）：
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
//   slot 注册：ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, ... }, 组件))
//   必须 export const inject = ["slots", "locale"]（缺 locale 会抛 without inject）。
//
// ⚠️ skill §4.1 铁律：CSS 模板字符串的注释里禁止出现反引号——会提前终结模板串，
//    把整个 DSH 启动打崩（web boot: 1 entry did not activate）。强调类名一律裸写。

window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-agent-hud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// settings.section 的渲染函数必须返回 React 元素（skill §3 契约）
		const React = require("react");
		const inject = ["slots", "locale"];

		const NS = "dsh-agent-hud";
		const API = "/@dsh-external/dsh-agent-hud/api";
		const SECTION_ID = "dsh-agent-hud-settings";
		// 界面版本水印（标题旁）。每次改本文件换一个值，一眼确认页面跑的是新代码
		const UI_VER = "0.2.0.a";
		const POLL_MS = 2000;

		// ─── 样式（模板串注释禁反引号）───────────────────────────────────
		const CSS = `
.dah-page { font-size: 13px; color: var(--dsh-text, #ddd); }
.dah-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.dah-title { font-size: 16px; font-weight: 600; }
.dah-ver { font-size: 11px; opacity: 0.55; }
.dah-tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(128,128,128,0.25); }
.dah-tab { padding: 6px 14px; cursor: pointer; border: none; background: transparent; color: inherit; opacity: 0.6; font-size: 13px; border-bottom: 2px solid transparent; }
.dah-tab.on { opacity: 1; font-weight: 600; border-bottom-color: #4d9fff; }
.dah-card { border: 1px solid rgba(128,128,128,0.25); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
.dah-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; flex-wrap: wrap; }
.dah-k { opacity: 0.65; min-width: 96px; }
.dah-mono { font-family: Consolas, monospace; font-size: 12px; word-break: break-all; }
.dah-badge { padding: 2px 10px; border-radius: 10px; font-size: 12px; }
.dah-on { background: rgba(76,175,80,0.18); color: #7cc47f; }
.dah-off { background: rgba(158,158,158,0.18); color: #999; }
.dah-ok { background: rgba(76,175,80,0.18); color: #7cc47f; }
.dah-bad { background: rgba(244,67,54,0.18); color: #e57368; }
.dah-btn { padding: 5px 14px; border-radius: 6px; border: 1px solid rgba(128,128,128,0.4); background: rgba(128,128,128,0.12); color: inherit; cursor: pointer; font-size: 13px; }
.dah-btn:hover { background: rgba(128,128,128,0.22); }
.dah-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dah-btn.primary { background: rgba(77,159,255,0.25); border-color: rgba(77,159,255,0.55); }
.dah-btn.danger { background: rgba(244,67,54,0.16); border-color: rgba(244,67,54,0.45); }
.dah-input { padding: 5px 8px; border-radius: 6px; border: 1px solid rgba(128,128,128,0.4); background: rgba(128,128,128,0.08); color: inherit; font-size: 13px; min-width: 240px; }
.dah-input.num { min-width: 90px; }
.dah-say { margin: 8px 0; padding: 8px 10px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; display: none; }
.dah-say.show { display: block; }
.dah-say.err { background: rgba(244,67,54,0.14); color: #e57368; }
.dah-say.info { background: rgba(77,159,255,0.12); color: #8ab8ff; }
.dah-tablewrap { overflow-x: auto; }
.dah-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dah-table th, .dah-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid rgba(128,128,128,0.18); vertical-align: top; }
.dah-table th { opacity: 0.6; font-weight: 600; white-space: nowrap; }
.dah-table td.nowrap { white-space: nowrap; }
.dah-empty { opacity: 0.55; padding: 14px 4px; }
.dah-note { opacity: 0.6; font-size: 12px; line-height: 1.7; }
`;

		// ─── 小工具 ─────────────────────────────────────────────────────
		function el(tag, cls, text) {
			const e = document.createElement(tag);
			if (cls) e.className = cls;
			if (text !== undefined) e.textContent = text;
			return e;
		}
		function clear(node) {
			while (node.firstChild) node.removeChild(node.firstChild);
		}
		function injectStyleOnce() {
			if (document.getElementById("dah-style")) return;
			const style = document.createElement("style");
			style.id = "dah-style";
			style.textContent = CSS;
			document.head.appendChild(style);
		}
		// 防连点（skill：busy 包装，点击即禁用）
		function busy(btn, busyText, fn) {
			return async () => {
				if (btn.disabled) return;
				const orig = btn.textContent;
				btn.disabled = true;
				btn.textContent = busyText;
				try {
					await fn();
				} finally {
					btn.disabled = false;
					btn.textContent = orig;
				}
			};
		}
		async function api(path, opts) {
			const r = await fetch(API + path, Object.assign({
				headers: { "content-type": "application/json" },
			}, opts || {}));
			let d = {};
			try { d = await r.json(); } catch { /* 非 JSON 响应 */ }
			if (!r.ok) throw new Error(String(d && d.error) || r.status + " " + r.statusText);
			return d;
		}
		function fmtTs(iso) {
			if (!iso) return "";
			const d = new Date(iso);
			return isNaN(d.getTime()) ? iso : d.toLocaleString();
		}

		// ─── 面板构建（单对象引用：skill §4.2 —— 赋值与读取必须在同一对象上）──
		function build(view) {
			const ctxObj = { page: el("div", "dah-page"), onTab: null };

			const head = el("div", "dah-head");
			head.appendChild(el("div", "dah-title", "Agent HUD 审批桥"));
			const ver = el("div", "dah-ver", "v" + UI_VER);
			head.appendChild(ver);
			ctxObj.page.appendChild(head);

			const tabs = el("div", "dah-tabs");
			const tabDefs = [["status", "状态"], ["settings", "设置"], ["log", "决策日志"]];
			const tabBtns = {};
			for (const [key, label] of tabDefs) {
				const b = el("button", "dah-tab", label);
				b.addEventListener("click", () => {
					if (typeof ctxObj.onTab === "function") ctxObj.onTab(key); // skill §4.2：经对象引用回调
				});
				tabBtns[key] = b;
				tabs.appendChild(b);
			}
			ctxObj.page.appendChild(tabs);

			const say = el("div", "dah-say");
			ctxObj.page.appendChild(say);

			const body = el("div", "dah-body");
			ctxObj.page.appendChild(body);

			ctxObj.say = (msg, isErr) => {
				say.className = "dah-say show " + (isErr ? "err" : "info");
				say.textContent = msg;
			};
			ctxObj.clearSay = () => {
				say.className = "dah-say";
				say.textContent = "";
			};
			ctxObj.setTab = (key) => {
				for (const k of Object.keys(tabBtns)) tabBtns[k].classList.toggle("on", k === key);
				ctxObj.tab = key;
				clear(body);
				if (key === "status") renderStatus(body);
				else if (key === "settings") renderSettings(body);
				else renderLog(body);
			};
			ctxObj.onTab = (key) => ctxObj.setTab(key);

			// ── 状态页 ──────────────────────────────────────────────────
			function renderStatus(body) {
				const card = el("div", "dah-card");
				const bridge = el("div", "dah-row");
				bridge.appendChild(el("span", "dah-k", "审批桥"));
				const badge = el("span", "dah-badge dah-off", "读取中…");
				bridge.appendChild(badge);
				const toggle = el("button", "dah-btn", "切换");
				toggle.addEventListener("click", busy(toggle, "提交中…", async () => {
					try {
						const d = await api("/settings", { method: "POST", body: JSON.stringify({ enabled: !ctxObj.health.enabled }) });
						ctxObj.health = Object.assign(ctxObj.health, { enabled: d.settings.enabled });
						drawStatus(badge);
						ctxObj.say(d.settings.enabled ? "审批桥已启用" : "审批桥已停用（完全旁路，不接管审批）");
					} catch (e) { ctxObj.say("切换失败：" + e.message, true); }
				}));
				bridge.appendChild(toggle);
				card.appendChild(bridge);

				const dirs = el("div", "dah-row");
				dirs.appendChild(el("span", "dah-k", "HUD 目录"));
				const dropBadge = el("span", "dah-badge", "…");
				const respBadge = el("span", "dah-badge", "…");
				dirs.appendChild(dropBadge);
				dirs.appendChild(respBadge);
				card.appendChild(dirs);

				const dropPath = el("div", "dah-row");
				dropPath.appendChild(el("span", "dah-k", "drop 路径"));
				const dropCode = el("span", "dah-mono", "…");
				dropPath.appendChild(dropCode);
				card.appendChild(dropPath);

				const respPath = el("div", "dah-row");
				respPath.appendChild(el("span", "dah-k", "resp 路径"));
				const respCode = el("span", "dah-mono", "…");
				respPath.appendChild(respCode);
				card.appendChild(respPath);

				const cfgRow = el("div", "dah-row");
				cfgRow.appendChild(el("span", "dah-k", "超时 / 轮询"));
				const cfgText = el("span", "", "…");
				cfgRow.appendChild(cfgText);
				card.appendChild(cfgRow);

				const actRow = el("div", "dah-row");
				const testBtn = el("button", "dah-btn primary", "测试 HUD（会弹一张测试卡片）");
				testBtn.addEventListener("click", busy(testBtn, "等待 HUD 响应…（最长 20 秒）", async () => {
					try {
						const d = await api("/test", { method: "POST", body: "{}" });
						ctxObj.say(d.verdict, !d.ok);
						refreshHealth().catch(() => {});
					} catch (e) { ctxObj.say("测试请求失败：" + e.message, true); }
				}));
				actRow.appendChild(testBtn);
				const sweepBtn = el("button", "dah-btn", "清理孤儿请求");
				sweepBtn.addEventListener("click", busy(sweepBtn, "清理中…", async () => {
					try {
						const d = await api("/sweep", { method: "POST", body: "{}" });
						ctxObj.say("已清理 " + d.removed + " 个孤儿请求文件");
					} catch (e) { ctxObj.say("清理失败：" + e.message, true); }
				}));
				actRow.appendChild(sweepBtn);
				card.appendChild(actRow);

				const note = el("div", "dah-note");
				note.textContent = "并行平级语义：权限确认出现时，DSH 原生审批卡片与 Agent HUD 气泡同时弹出；在哪边裁决都生效（先到先得），另一边自动作废。原生渠道不可用时由 HUD 独立裁决；HUD 超时未响应按拒绝处理（fail-closed）。v0.2.0 另有两种纯提醒（不阻塞、无需操作）：DSH 提问时弹提醒气泡（作答仍走原生卡片）；每个 agent 回合结束时弹任务完成气泡。可在设置页分别开关。";
				card.appendChild(note);
				body.appendChild(card);

				function drawStatus(b) {
					const on = !!(ctxObj.health && ctxObj.health.enabled);
					b.textContent = on ? "已启用" : "已停用";
					b.className = "dah-badge " + (on ? "dah-on" : "dah-off");
				}
				function drawHealth() {
					const h = ctxObj.health;
					if (!h) return;
					drawStatus(badge);
					dropBadge.textContent = h.dropDirExists ? "drop ✓" : "drop ✗ 不存在";
					dropBadge.className = "dah-badge " + (h.dropDirExists ? "dah-ok" : "dah-bad");
					respBadge.textContent = h.respDirExists ? "resp ✓" : "resp ✗ 不存在";
					respBadge.className = "dah-badge " + (h.respDirExists ? "dah-ok" : "dah-bad");
					dropCode.textContent = h.dropDir || "";
					respCode.textContent = h.respDir || "";
					cfgText.textContent = h.timeoutSec + " 秒 / " + h.pollMs + " 毫秒";
				}
				ctxObj.drawHealth = drawHealth;
				drawHealth();
			}

			// ── 设置页 ──────────────────────────────────────────────────
			function renderSettings(body) {
				const card = el("div", "dah-card");
				const h = ctxObj.health || {};
				const inputs = {};

				function field(label, key, isNum, hint) {
					const row = el("div", "dah-row");
					row.appendChild(el("span", "dah-k", label));
					const input = el("input", "dah-input" + (isNum ? " num" : ""));
					input.value = h[key] === undefined ? "" : String(h[key]);
					inputs[key] = input;
					row.appendChild(input);
					if (hint) row.appendChild(el("span", "dah-note", hint));
					card.appendChild(row);
				}
				field("超时秒数", "timeoutSec", true, "5–600，默认 110（需求值）");
				field("轮询间隔", "pollMs", true, "50–5000 毫秒，默认 200（需求值）");
				field("日志上限", "logMax", true, "10–5000 条");
				field("drop 目录", "dropDir", false, "HUD 请求投递目录");
				field("resp 目录", "respDir", false, "HUD 响应轮询目录");

				// v0.2.0 通知开关（checkbox）
				function checkRow(label, key, hint) {
					const row = el("div", "dah-row");
					row.appendChild(el("span", "dah-k", label));
					const cb = document.createElement("input");
					cb.type = "checkbox";
					cb.checked = !!h[key];
					inputs[key] = cb;
					row.appendChild(cb);
					if (hint) row.appendChild(el("span", "dah-note", hint));
					card.appendChild(row);
				}
				checkRow("提问提醒", "questionNotify", "DSH 发起提问时 HUD 弹提醒气泡（作答仍走原生卡片）");
				checkRow("任务完成提醒", "turnNotify", "每个 agent 回合结束时 HUD 弹提醒气泡");

				const row = el("div", "dah-row");
				const save = el("button", "dah-btn primary", "保存设置");
				save.addEventListener("click", busy(save, "保存中…", async () => {
					try {
						const patch = {};
						for (const k of Object.keys(inputs)) {
							const w = inputs[k];
							if (w.type === "checkbox") { patch[k] = w.checked; continue; }
							const v = w.value.trim();
							if (v !== "") patch[k] = v;
						}
						const d = await api("/settings", { method: "POST", body: JSON.stringify(patch) });
						ctxObj.health = d.settings;
						ctxObj.say("设置已保存（立即生效，无需重启）");
						if (typeof ctxObj.drawHealth === "function") ctxObj.drawHealth();
					} catch (e) { ctxObj.say("保存失败：" + e.message, true); }
				}));
				row.appendChild(save);
				const reset = el("button", "dah-btn", "还原显示值");
				reset.addEventListener("click", () => {
					const hh = ctxObj.health || {};
					for (const k of Object.keys(inputs)) {
						const w = inputs[k];
						if (w.type === "checkbox") { w.checked = !!hh[k]; continue; }
						w.value = hh[k] === undefined ? "" : String(hh[k]);
					}
				});
				row.appendChild(reset);
				card.appendChild(row);
				body.appendChild(card);
			}

			// ── 日志页 ──────────────────────────────────────────────────
			function renderLog(body) {
				const card = el("div", "dah-card");
				const row = el("div", "dah-row");
				const refresh = el("button", "dah-btn", "刷新");
				refresh.addEventListener("click", busy(refresh, "刷新中…", async () => { await loadLog(); }));
				row.appendChild(refresh);
				const clearBtn = el("button", "dah-btn danger", "清空日志");
				clearBtn.addEventListener("click", busy(clearBtn, "清空中…", async () => {
					try {
						await api("/clear-log", { method: "POST", body: "{}" });
						ctxObj.decisions = [];
						drawLog();
						ctxObj.say("决策日志已清空");
					} catch (e) { ctxObj.say("清空失败：" + e.message, true); }
				}));
				row.appendChild(clearBtn);
				card.appendChild(row);

				const wrap = el("div", "dah-tablewrap");
				card.appendChild(wrap);
				body.appendChild(card);

				async function loadLog() {
					try {
						const d = await api("/decisions?limit=50");
						ctxObj.decisions = d.decisions || [];
						drawLog();
					} catch (e) { ctxObj.say("读取日志失败：" + e.message, true); }
				}
				function drawLog() {
					clear(wrap);
					const list = ctxObj.decisions || [];
					if (!list.length) {
						wrap.appendChild(el("div", "dah-empty", "暂无决策记录。上游应答器都不响应时，权限确认会落到 HUD，这里会出现记录。"));
						return;
					}
					const t = el("table", "dah-table");
					const thead = el("thead");
					const hr = el("tr");
					for (const hText of ["时间", "工具", "结果", "来源", "详情"]) hr.appendChild(el("th", "", hText));
					thead.appendChild(hr);
					t.appendChild(thead);
					const tbody = el("tbody");
					for (const d of list) {
						const tr = el("tr");
						tr.appendChild(el("td", "nowrap", fmtTs(d.ts)));
						tr.appendChild(el("td", "", String(d.tool || "")));
						const outcome = String(d.outcome || "");
						const ot = el("td", "nowrap", outcome === "allowed-once" ? "✓ 放行" : outcome === "cancelled" ? "⊘ 取消" : outcome === "rejected" ? "✗ 拒绝" : outcome);
						ot.className = "nowrap " + (outcome === "allowed-once" ? "dah-ok" : outcome === "rejected" ? "dah-bad" : "");
						tr.appendChild(ot);
						tr.appendChild(el("td", "nowrap", String(d.source || "")));
						tr.appendChild(el("td", "", String(d.detail || "")));
						tbody.appendChild(tr);
					}
					t.appendChild(tbody);
					wrap.appendChild(t);
				}
				ctxObj.loadLog = loadLog;
				loadLog();
			}

			async function refreshHealth() {
				ctxObj.health = await api("/health");
				if (typeof ctxObj.drawHealth === "function") ctxObj.drawHealth();
			}
			ctxObj.refreshHealth = refreshHealth;
			return ctxObj; // skill §4.2：必须返回同一个对象引用
		}

		// ─── React 组件壳（settings.section 第 2 参必须是组件本身）─────────
		function HudPanel() {
			const hostRef = React.useRef(null);
			React.useEffect(() => {
				const host = hostRef.current;
				if (!host) return;
				injectStyleOnce();
				const view = build();
				host.appendChild(view.page);
				view.setTab("status");

				let disposed = false;
				const timer = setInterval(() => {
					if (disposed || view.tab !== "status") return;
					view.refreshHealth().catch(() => { /* host API 短暂不可达不刷屏 */ });
				}, POLL_MS);
				view.refreshHealth().catch((e) => view.say("host API 不可达（" + API + "）：" + e.message, true));

				return () => {
					disposed = true;
					clearInterval(timer);
				};
			}, []);
			return React.createElement("div", { ref: hostRef, className: "dah-host" });
		}

		// ─── apply：locale + settings.section 注册 ─────────────────────────
		function apply(ctx) {
			// NS 必须是常量字符串（locale.register 返回的是 disposer，不是命名空间）
			ctx.effect(() => ctx.locale.register(NS, {
				zh: { title: "Agent HUD 审批桥" },
				en: { title: "Agent HUD Approval Bridge" },
			}), "dsh-agent-hud: locale");

			// 描述符存进 entry.options 的只有 name/id/order/label/priority（icon 会被丢弃）
			// label 必须是函数；locale 必须与上面 register 的命名空间一致
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register(
				{
					name: "settings.section",
					id: SECTION_ID,
					order: 61,
					label: () => ctx.locale.bind(NS)("title"),
					locale: NS,
				},
				HudPanel,
			)), "dsh-agent-hud: settings.section 面板");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
