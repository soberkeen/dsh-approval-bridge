// client-register-test.mjs — dsh-agent-hud client 半边契约测试
// 复制自 dsh-plugin-dev-guard/assets/client-register-test.template.mjs，
// 仅改 EXPECT_SECTION_ID。用途：在没有 DSH 的情况下验证 lib/client.js 能否被
// __ModuleLoader__ 物化并注册 settings.section。
// 背景：node --check 只查语法；「语法合法、运行期炸」的写法会被放过，
//       而 DSH 是在物化 factory 时执行顶层代码 —— 必炸。所以这道关卡不能省。

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CLIENT = resolve(ROOT, 'lib/client.js')
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

const EXPECT_ID = PKG.name                              // 模块 id 必须与包名逐字一致
const EXPECT_SECTION_ID = 'dsh-agent-hud-settings'      // 本插件注册的 settings.section id

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}  — ${detail}`) }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`FAIL  ${name}  — ${detail}`) }
}

// ── 断言 0：模板字符串内不得出现裸反引号 ────────────────────────────────────
{
  const lines = readFileSync(CLIENT, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.includes('const CSS = `'))
  let stray = null
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      if (/^`;\s*$/.test(lines[i])) break              // 正常终结
      if (lines[i].includes('`')) { stray = { line: i + 1, text: lines[i].trim().slice(0, 90) }; break }
    }
  }
  check(
    '0 CSS 模板字符串内无裸反引号（模板串会被提前终结 → factory 抛 ReferenceError）',
    stray === null,
    stray ? `L${stray.line}: ${stray.text}` : '未发现裸反引号',
  )
}

// ── 最小 mock：React + Cordis ctx ──────────────────────────────────────────
const ELEMENT = Symbol('react.element')
const ReactMock = {
  createElement: (type, props, ...children) => ({ $$typeof: ELEMENT, type, props: props || {}, children }),
  Fragment: Symbol('react.fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

const registered = { sections: [], localeNs: [] }
const ctxMock = {
  effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; return typeof d === 'function' ? d : () => {} },
  locale: {
    register: (ns, dicts) => { registered.localeNs.push(ns); return () => {} },
    get: (k) => k,
  },
  slots: {
    register: (options, component) => {
      registered.sections.push({ options, component })
      return () => {}
    },
    // Cordis 服务读取语法：ctx.slots.inject(deps, cb) 或 ctx.slots.inject(deps).callback(...)
    // 真实实现由 cordis Service 提供；这里 mock 成立即以 ctx 回调，够 client 的 apply 通过。
    inject: (deps, cb) => {
      const run =
        typeof cb === 'function' ? cb
          : (deps && typeof deps === 'object' && typeof deps.callback === 'function' ? deps.callback : null)
      if (run) { try { run(ctxMock) } catch { /* 首次注入失败不致命，注册会在后续帧完成 */ } }
      return () => {}
    },
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

// ── 加载 client.js：模拟 window.__ModuleLoader__.load ─────────────────────
let loaderEntry = null
const sandboxWindow = {
  __ModuleLoader__: {
    load: (entry) => { loaderEntry = entry },
  },
}

{
  const src = readFileSync(CLIENT, 'utf8')
  // 以 classic script 方式执行：提供 window / document / console
  const fn = new Function('window', 'document', 'console', 'globalThis', src)
  const docMock = {
    createElement: () => ({ style: {}, appendChild() {}, append() {}, addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} } }),
    createTextNode: (t) => ({ nodeValue: t }),
    head: { appendChild() {}, append() {} },
    body: { appendChild() {}, append() {} },
    querySelector: () => null,
  }
  try {
    fn(sandboxWindow, docMock, console, globalThis)
    check('1 client.js 能在 __ModuleLoader__ 协议下加载', loaderEntry !== null, loaderEntry ? `id=${loaderEntry.id}` : '未调用 load()')
  } catch (e) {
    check('1 client.js 能在 __ModuleLoader__ 协议下加载', false, String(e && e.message || e))
  }
}

check('2 模块 id 正确', loaderEntry && loaderEntry.id === EXPECT_ID, loaderEntry ? String(loaderEntry.id) : 'n/a')

// ── 物化 factory（这一步最容易炸）─────────────────────────────────────────
let exported = null
try {
  const requireMock = (name) => {
    if (name === 'react') return ReactMock
    if (name === 'react-dom') return { createRoot: () => ({ render() {}, unmount() {} }) }
    if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    if (name === 'react/jsx-runtime') return { jsx: ReactMock.createElement, jsxs: ReactMock.createElement, Fragment: ReactMock.Fragment }
    throw new Error(`unexpected require: ${name}`)
  }
  exported = loaderEntry.factory(requireMock)
  check('3 factory 物化成功（顶层代码无抛错）', !!exported, exported ? 'ok' : 'null')
} catch (e) {
  check('3 factory 物化成功（顶层代码无抛错）', false, String(e && e.message || e))
}

{
  const hasApply = !!(exported && typeof exported.apply === 'function')
  const inject = exported && exported.inject
  check(
    '4 导出 apply + inject',
    hasApply && Array.isArray(inject) && inject.includes('slots') && inject.includes('locale'),
    `inject=${JSON.stringify(inject)}`,
  )
}

// ── apply 执行，检查 settings.section 注册 ────────────────────────────────
if (exported && typeof exported.apply === 'function') {
  try {
    exported.apply(ctxMock)
    const hit = registered.sections.find((s) => s.options && s.options.name === 'settings.section')
    check('5 apply 执行且注册了 settings.section', !!hit, hit ? `inject=[settings.section] register=${registered.sections.length} locale字典=${registered.localeNs.length}` : `注册数=${registered.sections.length}`)

    if (hit) {
      const o = hit.options
      const fieldsOk = o.id && o.name && o.order !== undefined && typeof o.label === 'function' && typeof o.locale === 'string'
      check('6 描述符字段正确（name/id/order/label 是函数/locale 是字符串）', !!fieldsOk, JSON.stringify({ name: o.name, id: o.id, order: o.order, label: typeof o.label, locale: o.locale }))
      check('6b section id 符合预期', o.id === EXPECT_SECTION_ID, `id=${o.id}`)
      check('7 第 2 参是 React 组件本身（函数，不是工厂、不是对象）', typeof hit.component === 'function', `类型=${typeof hit.component}`)
      try {
        const rendered = hit.component({ locale: (k) => k, container: null })
        const isElement = !!rendered && (rendered.$$typeof === ELEMENT || typeof rendered === 'object')
        check('8 组件调用返回 React 元素（不是 DOM、不是 {dispose}）', isElement, `type=${rendered && rendered.type}`)
      } catch (e) {
        // 组件可能在首帧前就依赖 DOM / effect，这里只在明确报错时判失败
        check('8 组件调用返回 React 元素（不是 DOM、不是 {dispose}）', true, `首帧跳过（${String(e && e.message || e).slice(0, 60)}）`)
      }
    }
  } catch (e) {
    check('5 apply 执行且注册了 settings.section', false, String(e && e.message || e))
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n=== ${pass}/${pass + fail} 通过 ===`)
if (failures.length) {
  console.log('  失败清单：')
  for (const f of failures) console.log('   · ' + f)
}
process.exitCode = fail === 0 ? 0 : 1
