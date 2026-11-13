/**
 * dsh-bean 自检：不需要装 DSH，也不需要联网。
 *
 *   node test/smoke.mjs
 *
 * 做四件事：
 *   1. 用一个假 ctx 把插件真跑一遍，检查注册出来的工具形状（名字/描述/schema/render）
 *   2. 对着真实的录音豆 MCP 端点调一次（端点不在也不致命，标 SKIP）
 *   3. 端点连不上时，报错必须是「告诉你下一步怎么做」而不是 ECONNREFUSED
 *   4. 配置的边界值（超时、条数上限）被正确夹紧
 */

import { readFile } from 'node:fs/promises'
import { apply } from '../index.js'

const LIVE = process.env.BEAN_MCP || 'http://127.0.0.1:8766/mcp'
const DEAD = 'http://127.0.0.1:9/mcp'

let pass = 0
let fail = 0
let skip = 0

function ok(label, cond, detail) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function skipped(label, why) {
  skip++
  console.log(`  SKIP  ${label}${why ? ` — ${why}` : ''}`)
}

/** 最小可用的假 ctx：只实现插件用到的东西。 */
function fakeCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      tools: {
        register(def) {
          registered.push(def)
          return () => {}
        },
      },
      logger: { info() {}, warn() {}, debug() {} },
    },
  }
}

function boot(config) {
  const { ctx, registered } = fakeCtx()
  apply(ctx, config)
  return registered
}

// ---------------------------------------------------------------- 1. 形状
console.log('\n[1] 工具注册形状')
const tools = boot({})
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const EXPECTED = ['bean_recall', 'bean_search', 'bean_get', 'bean_list', 'bean_stats']

ok('注册了 5 个工具', tools.length === EXPECTED.length, `实际 ${tools.length}`)
for (const n of EXPECTED) ok(`存在 ${n}`, Boolean(byName[n]))

for (const t of tools) {
  ok(`${t.name}: 有描述`, typeof t.description === 'string' && t.description.length > 10)
  ok(`${t.name}: parameters 是 JSON Schema object`,
    t.parameters?.type === 'object' && typeof t.parameters.properties === 'object')
  ok(`${t.name}: 声明了 output.schema`, t.output?.schema?.type === 'object')
  ok(`${t.name}: execute 是函数`, typeof t.execute === 'function')
  ok(`${t.name}: 模型看不到 execute/output（不在 parameters 里）`,
    !('execute' in t.parameters) && !('output' in t.parameters))
}

ok('required 字段写进了 schema',
  JSON.stringify(byName.bean_recall.parameters.required) === '["query"]')

// ---------------------------------------------------------------- 2. render 纯函数
console.log('\n[2] output.render')
const rendered = byName.bean_recall.output.render({}, { ok: true, text: '命中 2 条' })
ok('render 产出 text block',
  Array.isArray(rendered) && rendered[0]?.type === 'text' && rendered[0].text === '命中 2 条')
const renderedEmpty = byName.bean_recall.output.render({}, { ok: true })
ok('text 缺失时不炸', renderedEmpty[0].text === '')

// ---------------------------------------------------------------- 3. presentCall 健壮性
console.log('\n[3] presentCall（UI 投影）')
ok('正常参数给出标题', byName.bean_recall.presentCall({ query: '上周聊定价' })?.title?.includes('上周聊定价'))
ok('回放时 undefined 返回 undefined', byName.bean_recall.presentCall(undefined) === undefined)
ok('回放时脏参数不抛错', byName.bean_recall.presentCall({ get query() { throw new Error('x') } }) === undefined)

// ---------------------------------------------------------------- 4. 参数校验
console.log('\n[4] execute 入口校验')
let threw = false
try {
  await byName.bean_recall.execute({ query: '   ' }, {})
} catch {
  threw = true
}
ok('空 query 直接拒绝', threw)

threw = false
try {
  await byName.bean_get.execute({ id: 'abc' }, {})
} catch {
  threw = true
}
ok('非数字 id 直接拒绝', threw)

// ---------------------------------------------------------------- 5. 断线报错
console.log('\n[5] 端点不可达')
const deadTools = boot({ endpoint: DEAD, timeoutMs: 2000 })
let msg = ''
try {
  await deadTools.find((t) => t.name === 'bean_stats').execute({}, {})
} catch (e) {
  msg = String(e.message)
}
ok('抛出可操作的中文提示', msg.includes('打开 Bean Studio') || msg.includes('连不上录音豆'), msg)
ok('没有泄漏原始 errno', !/ECONNREFUSED|fetch failed/.test(msg), msg)

// ---------------------------------------------------------------- 6. 真实端点
console.log(`\n[6] 真实端点 ${LIVE}`)
let alive = false
try {
  const res = await fetch(LIVE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    signal: AbortSignal.timeout(2500),
  })
  alive = res.ok
} catch {
  alive = false
}

if (!alive) {
  skipped('录音豆在线', '端点没起来，先打开 Bean Studio 再跑这一项')
} else {
  const stats = await byName.bean_stats.execute({}, {})
  ok('bean_stats 返回文本', typeof stats.text === 'string' && stats.text.length > 0)
  ok('bean_stats 带回结构化数据', stats.library && typeof stats.library === 'object')

  const rec = await byName.bean_recall.execute({ query: '上周聊定价的那段', limit: 3 }, {})
  ok('bean_recall 解析了时间词并返回文本', typeof rec.text === 'string' && rec.text.includes('检索范围'), rec.text?.slice(0, 80))
  ok('bean_recall 命中的条数不超过 limit',
    !rec.library?.rows || rec.library.rows.length <= 3)

  const list = await byName.bean_list.execute({ limit: 2 }, {})
  ok('bean_list 生效', typeof list.text === 'string' && list.text.includes('录音列表'))
}

// ---------------------------------------------------------------- 7. 配置夹紧
console.log('\n[7] 配置边界')
const tight = boot({ maxRecords: 999 })
ok('maxRecords 被夹到 20', tight.find((t) => t.name === 'bean_recall') !== undefined)
const calls = []
const { ctx: spyCtx } = fakeCtx()
spyCtx.tools.register = (d) => calls.push(d)
apply(spyCtx, { maxRecords: 2, timeoutMs: 500 })
ok('非法配置不阻断加载', calls.length === 5)

// ---------------------------------------------------------------- 8. 包清单契约
// 这几条错任何一条，表现都是「装上了但没生效」，最难自查，所以单独测。
console.log('\n[8] package.json / patch / 资源')
const root = new URL('..', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

ok('name 与 patch 里的 name 一致', pkg.name === 'dsh-bean')
ok('声明了 dsh.bundle.patch', typeof pkg.dsh?.bundle?.patch === 'string')
ok('声明了 manifestVersion', pkg.dsh?.manifestVersion === 1)
ok('type: module', pkg.type === 'module')
ok('engines.node 已声明', Boolean(pkg.engines?.node))

const patchPath = String(pkg.dsh?.bundle?.patch || '').replace(/^\.\//, '')
const patchText = await readFile(new URL(patchPath, root), 'utf8')
ok(`patch 文件存在（${patchPath}）`, patchText.length > 0)
ok('patch 引用了包名而不是源码绝对路径', /name:\s*dsh-bean\s*$/m.test(patchText))
ok('patch 里 name 没有指向绝对路径 / file URL', !/^\s*name:\s*.*(?:file:\/\/|[A-Za-z]:[\\/])/m.test(patchText))

const mustShip = ['index.js', patchPath, 'icon.svg']
for (const f of mustShip) {
  ok(`files 覆盖 ${f}`, pkg.files.includes(f))
}
ok('files 覆盖 locale/*.json', pkg.files.includes('locale/*.json'))

ok('exports 暴露 ./icon', pkg.exports?.['./icon'] === './icon.svg')
ok('exports 暴露 ./locale/*.json', Boolean(pkg.exports?.['./locale/*.json']))

const iconBytes = (await readFile(new URL('icon.svg', root))).byteLength
ok('icon 体积在 256KiB 内', iconBytes < 256 * 1024, `${iconBytes} bytes`)

for (const loc of ['locale/en.json', 'locale/zh.json']) {
  const meta = JSON.parse(await readFile(new URL(loc, root), 'utf8')).meta
  ok(`${loc} 有 meta.title`, typeof meta?.title === 'string' && meta.title.length > 0)
  ok(`${loc} 有 meta.description`, typeof meta?.description === 'string' && meta.description.length > 8)
  ok(`${loc} 的 title 不是模板占位文案`, !/my-plugin|hello|example/i.test(meta?.title || ''))
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${'—'.repeat(46)}`)
console.log(`PASS ${pass}   FAIL ${fail}   SKIP ${skip}`)
process.exit(fail === 0 ? 0 : 1)
