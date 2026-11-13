/**
 * dsh-bean — 把「录音豆 Bean Studio」的本地录音库变成 DeepSeek Harness 的一项能力。
 *
 * 典型用法：在 dsh 里直接问「上周聊定价的那段说了什么」，
 * 模型调用 bean_recall → 时间词自动解析 → 返回命中录音的原文片段。
 *
 * 设计约束（都是刻意的）：
 * - **零 import、零依赖、零构建**。插件只依赖 Node 内置能力（fetch / AbortSignal）。
 *   Harness 的插件跑在 host 进程里，多一个依赖就多一个装不上的可能；而这类故障
 *   在客户端侧的表现是「插件不生效」，极难自查。
 * - 工具用裸 `ToolDefinition` 注册（`{ name, description, parameters, output, execute }`），
 *   不走 `defineTool`。`defineTool` 只是 TS 类型推断与参数校验的糖，裸注册的
 *   `parameters` 直接就是模型看到的 JSON Schema —— 省掉一个包解析路径。
 * - 真正的检索逻辑不在这个仓库，在 Bean Studio 的 MCP server 里（mcp/server.py）。
 *   插件是一层薄桥：好处是命令行、编辑器、DSH 三处行为完全一致，不会各写一份解析。
 */

/** 插件身份，与 cordis.patch.yml 里的行 id 对应。 */
export const name = 'bean-studio'

/** 依赖 tools 服务就绪后再 apply。 */
export const inject = ['tools']

const DEFAULTS = {
  endpoint: 'http://127.0.0.1:8766/mcp',
  timeoutMs: 20000,
  maxRecords: 5,
}

/** 规范化的工具返回值。render 把 text 交给模型，library 留给上层做卡片/回放。 */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
      library: { type: 'object', additionalProperties: true },
    },
    required: ['ok', 'text'],
    additionalProperties: true,
  },
  render: (_args, value) => [{ type: 'text', text: String(value.text ?? '') }],
}

// ---------------------------------------------------------------- 配置

function normalize(config) {
  const c = config ?? {}
  const endpoint = String(c.endpoint ?? DEFAULTS.endpoint).trim() || DEFAULTS.endpoint
  const timeoutMs = Number.isFinite(Number(c.timeoutMs)) && Number(c.timeoutMs) > 0
    ? Number(c.timeoutMs)
    : DEFAULTS.timeoutMs
  const maxRecords = Number.isFinite(Number(c.maxRecords)) && Number(c.maxRecords) > 0
    ? Math.min(Number(c.maxRecords), 20)
    : DEFAULTS.maxRecords
  return { endpoint, timeoutMs, maxRecords }
}

// ---------------------------------------------------------------- MCP 客户端

let seq = 0

/** endpoint 连不上时，说清楚下一步该做什么，而不是抛一个 ECONNREFUSED。 */
function unreachable(cfg, cause) {
  // fetch 的网络错误只给 `fetch failed`，真正的原因埋在 cause 链里（还可能是 AggregateError）
  const code = cause?.cause?.code
    || cause?.code
    || cause?.cause?.errors?.[0]?.code
    || ''
  const why = cause?.name === 'TimeoutError'
    ? `请求超时（${cfg.timeoutMs}ms）`
    : (code === 'ECONNREFUSED' ? '端口没在监听' : (code || '连接失败'))
  return new Error(
    `连不上录音豆（${cfg.endpoint}，${why}）。` +
    '请先打开 Bean Studio —— 双击 BeanStudio.exe 或 run.bat，' +
    '然后在「设置」里确认「MCP 服务」是打开状态（默认端口 8766）。'
  )
}

function parseSse(raw) {
  const out = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^data:\s*(.*)$/.exec(line)
    if (!m) continue
    try {
      out.push(JSON.parse(m[1]))
    } catch {
      /* 心跳行，忽略 */
    }
  }
  return out
}

async function rpc(cfg, method, params, outerSignal) {
  const budget = AbortSignal.timeout(cfg.timeoutMs)
  const signal = outerSignal ? AbortSignal.any([outerSignal, budget]) : budget

  let res
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
      signal,
    })
  } catch (err) {
    if (outerSignal?.aborted) throw err // 调用方主动取消，原样上抛
    throw unreachable(cfg, err)
  }

  if (!res.ok) {
    throw new Error(`录音豆 MCP 返回 HTTP ${res.status}（${cfg.endpoint}）`)
  }

  const ctype = res.headers.get('content-type') || ''
  const raw = await res.text()
  const payload = ctype.includes('text/event-stream') ? parseSse(raw).pop() : JSON.parse(raw)
  if (!payload) throw new Error('录音豆 MCP 返回了空响应')
  if (payload.error) {
    throw new Error(payload.error.message || `MCP 错误 ${payload.error.code}`)
  }
  return payload.result
}

/** 调一个录音豆 MCP 工具，返回 { text, library }。 */
async function callTool(cfg, tool, args, signal) {
  const result = await rpc(cfg, 'tools/call', { name: tool, arguments: args }, signal)
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
  if (result?.isError) throw new Error(text || '录音豆返回了一个错误结果')
  return { ok: true, text, library: result?.structuredContent ?? {} }
}

// ---------------------------------------------------------------- 工具定义

/** 每个工具：模型看到的 name/description/parameters + 上面那套 output。 */
function specs(cfg) {
  const cap = (n, fallback) => {
    const v = Number(n)
    return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), cfg.maxRecords) : fallback
  }
  // 描述里写的「默认 N 条」必须是真会发生的 N —— maxRecords 调小过就要跟着变
  const recallDefault = Math.min(5, cfg.maxRecords)

  return [
    {
      name: 'bean_recall',
      when: (a) => `检索录音库 · ${a.query}`,
      description:
        '在本地录音库里按「时间 + 主题」召回内容 —— 这是主入口。' +
        '用户说「上周聊定价那段」「昨天那个电话说了什么」「最近三天关于 OTA 的」，' +
        '把原话整句传进 query 即可，时间词会自动解析' +
        '（今天/昨天/前天/本周/上周/上上周/最近N天/上个月/11月5号）。' +
        '返回命中的原文片段与录音 id。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '用户原话，含时间词和主题，例如：上周聊定价的那段' },
          limit: { type: 'integer', description: `返回条数，默认 ${recallDefault}` },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const q = String(args?.query ?? '').trim()
        if (!q) throw new Error('query 不能为空；把用户原话整句传进来，例如：上周聊定价的那段')
        return callTool(cfg, 'recall', { query: q, limit: cap(args.limit, recallDefault) }, exec?.signal)
      },
    },
    {
      name: 'bean_search',
      when: (a) => `关键词检索 · ${a.query}`,
      description:
        '显式关键词检索，可指定时间范围（YYYY-MM-DD）和场景。' +
        '需要自己控制条件时用这个，日常用 bean_recall 即可。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，空格分隔多个' },
          since: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          until: { type: 'string', description: '结束日期 YYYY-MM-DD（含当天）' },
          scene: {
            type: 'string',
            description: '场景：meeting/interview/sales/comm/call/media/event/course/idea',
          },
          limit: { type: 'integer' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const q = String(args?.query ?? '').trim()
        if (!q) throw new Error('query 不能为空')
        const payload = { query: q }
        if (args.since) payload.since = String(args.since)
        if (args.until) payload.until = String(args.until)
        if (args.scene) payload.scene = String(args.scene)
        if (args.limit) payload.limit = cap(args.limit, 10)
        return callTool(cfg, 'search_recordings', payload, exec?.signal)
      },
    },
    {
      name: 'bean_get',
      when: (a) => `取录音全文 #${a.id}`,
      description: '取某条录音的完整信息：全文转写、摘要、时长、场景、时间、音频文件路径。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer', description: '录音 id（bean_recall 结果里的 #号）' } },
        required: ['id'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const id = Number(args?.id)
        if (!Number.isInteger(id) || id <= 0) throw new Error('id 必须是正整数')
        return callTool(cfg, 'get_recording', { id }, exec?.signal)
      },
    },
    {
      name: 'bean_list',
      when: (a) => `列出录音${a.scene ? ` · ${a.scene}` : ''}`,
      description: '列出录音（按时间倒序）。可按场景、星标、时间范围过滤。用于「我最近都录了什么」。',
      parameters: {
        type: 'object',
        properties: {
          scene: { type: 'string' },
          starred: { type: 'boolean', description: '只看星标' },
          since: { type: 'string', description: 'YYYY-MM-DD' },
          until: { type: 'string', description: 'YYYY-MM-DD（含当天）' },
          limit: { type: 'integer', description: '默认 20' },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const payload = {}
        for (const k of ['scene', 'since', 'until']) {
          if (args?.[k]) payload[k] = String(args[k])
        }
        if (args?.starred) payload.starred = true
        if (args?.limit) payload.limit = Math.min(Math.floor(Number(args.limit)) || 20, 100)
        return callTool(cfg, 'list_recordings', payload, exec?.signal)
      },
    },
    {
      name: 'bean_stats',
      when: () => '录音库概览',
      description: '录音库概览：总条数、总时长、近 7 天、场景分布、未完成待办数。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, exec) {
        return callTool(cfg, 'recording_stats', {}, exec?.signal)
      },
    },
  ]
}

/** 组装成裸 ToolDefinition。 */
function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: OUTPUT,
    execute: spec.execute,
    // 内置 Web Client 目前不消费 present*/（只有 Client 插件的 toolview 槽位消费），
    // 但这两个投影是纯函数、成本为零，留给后续卡片与第三方 UI 用。
    presentCall(args) {
      if (!args || typeof args !== 'object') return undefined
      try {
        return { card: 'generic', title: spec.when(args), kind: 'search', rawInput: args }
      } catch {
        return undefined
      }
    },
  }
}

// ---------------------------------------------------------------- 入口

export function apply(ctx, config) {
  const cfg = normalize(config)
  const defs = specs(cfg)
  for (const spec of defs) {
    ctx.tools.register(defineTool(spec))
  }
  try {
    ctx.logger?.info?.(`[dsh-bean] ${defs.length} 个工具已挂载 → ${cfg.endpoint}`)
  } catch {
    /* 日志失败不影响功能 */
  }
}
