/**
 * 契约测试：拿真实的 `@deepseek-ai/dsh-tools` 校验这个插件的工具定义。
 *
 *   node test/contract.mjs
 *   DSH_TOOLS=/path/to/node_modules/@deepseek-ai/dsh-tools/lib/index.js node test/contract.mjs
 *
 * 这一步不是可选的锦上添花 —— 有三件事只有对着真包才能确认：
 *   1. `output.schema` 落在 DSH 支持的 JSON Schema 子集里（注册时会当场校验，不合格直接抛）
 *   2. 注册进去的 `parameters` 会被原样投影给模型（`projectToolSchema` 不做编译），
 *      所以这里写的必须是**原生 JSON Schema**，不是 defineTool 那套属性映射 DSL
 *   3. `execute` 真的返回值满足自己声明的 `output.schema` —— 不满足就是运行期 isError，
 *      而且是在模型已经决定调用之后才炸
 *
 * 找不到 dsh-tools 时整段 SKIP，不会影响 `smoke.mjs` 的零依赖定位。
 */

import { apply } from '../index.js'

let dsh
try {
  dsh = await import(process.env.DSH_TOOLS || '@deepseek-ai/dsh-tools')
} catch {
  console.log('SKIP  找不到 @deepseek-ai/dsh-tools')
  console.log('      先装一份 DSH：npm i @deepseek-ai/dsh，')
  console.log('      或用 DSH_TOOLS=<.../dsh-tools/lib/index.js> 指定路径。')
  process.exit(0)
}

const { assertSupportedJsonSchema, validateJsonSchemaValue, projectToolSchema } = dsh

const LIVE = process.env.BEAN_MCP || 'http://127.0.0.1:8766/mcp'
let pass = 0
let fail = 0

function ok(label, cond, detail) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const tools = []
apply({ tools: { register: (d) => (tools.push(d), () => {}) }, logger: {} }, { endpoint: LIVE })

// ---------------------------------------------------------------- 1. 注册期校验
console.log('\n[1] output.schema 是否在 DSH 支持的子集内')
for (const t of tools) {
  let err = null
  try {
    assertSupportedJsonSchema(t.output.schema)
  } catch (e) {
    err = e.message
  }
  ok(`${t.name}: assertSupportedJsonSchema 通过`, err === null, err)
}

// ---------------------------------------------------------------- 2. 投影给模型的东西
console.log('\n[2] parameters 原样投影（验证「原生 JSON Schema」这个判断）')
for (const t of tools) {
  const projected = projectToolSchema(t, true)
  ok(`${t.name}: 投影只保留 model-facing 字段`,
    JSON.stringify(Object.keys(projected).sort()) === '["description","name","parameters"]',
    Object.keys(projected).join(','))
  ok(`${t.name}: parameters 是 deep copy 且内容一致`,
    JSON.stringify(projected.parameters) === JSON.stringify(t.parameters))
  ok(`${t.name}: 模型看到的根是 type=object`,
    projected.parameters?.type === 'object' && typeof projected.parameters.properties === 'object')
}

// ---------------------------------------------------------------- 3. 参数 schema 描述得对不对
console.log('\n[3] 参数 schema 与实际接受的入参一致')
const argCases = [
  ['bean_recall', { query: '上周聊定价的那段', limit: 3 }, true],
  // 空串在 JSON Schema 层面是合法的 —— 非空这类约束由 execute 自己拒绝（官方文档明确如此），
  // 所以这里期望「schema 放行」，`smoke.mjs` 里另有「execute 必须抛错」的断言。
  ['bean_recall', { query: '' }, true],
  ['bean_recall', {}, false],
  ['bean_search', { query: 'OTA', since: '2026-11-01', until: '2026-11-09', limit: 5 }, true],
  ['bean_get', { id: 21 }, true],
  ['bean_get', { id: '-1' }, false],
  ['bean_list', { starred: true, limit: 2 }, true],
  ['bean_stats', {}, true],
]
for (const [name, args, shouldPass] of argCases) {
  const t = tools.find((x) => x.name === name)
  const violations = validateJsonSchemaValue(t.parameters, args, '')
  const passes = violations.length === 0
  ok(`${name}(${JSON.stringify(args)}) → schema ${shouldPass ? '放行' : '拒绝'}`,
    passes === shouldPass, violations.join('; '))
}

// ---------------------------------------------------------------- 4. execute 返回值
console.log('\n[4] execute 返回值满足 output.schema')
let live = false
try {
  live = (await fetch(LIVE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    signal: AbortSignal.timeout(2500),
  })).ok
} catch {
  live = false
}

if (!live) {
  console.log('  SKIP  录音豆没在跑，跳过真实返回值校验')
} else {
  for (const [name, args] of [['bean_stats', {}], ['bean_recall', { query: '最近七天', limit: 2 }]]) {
    const t = tools.find((x) => x.name === name)
    const value = await t.execute(args, {})
    const violations = validateJsonSchemaValue(t.output.schema, value, '')
    ok(`${name}: 返回值合法${violations.length ? `（${violations.join('; ')}）` : ''}`, violations.length === 0)
    const rendered = t.output.render(args, value)
    ok(`${name}: render 产出 text block`,
      Array.isArray(rendered) && rendered[0]?.type === 'text' && typeof rendered[0].text === 'string')
  }
}

console.log(`\n${'—'.repeat(46)}`)
console.log(`PASS ${pass}   FAIL ${fail}`)
// 用 exitCode 而不是 process.exit()：Windows 上 undici 的 keep-alive socket 在
// 进程被强制退出时会打一条 libuv assert，污染输出（不影响结果，但看起来像崩了）。
process.exitCode = fail === 0 ? 0 : 1
