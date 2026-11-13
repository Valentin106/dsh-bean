# dsh-bean

Bring your **local recording library** into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Ask "what did we decide about pricing last Wednesday?" in chat and the matching transcript snippet lands in context — no app switching, no scrolling a list, no reaching for the device.

The library itself is **Bean Studio**, a private desktop app for the Anker recording-bean D3200 (not open source): it records, transcribes locally (faster-whisper, offline, free), and recalls by *time + topic*. This repo only turns it into a DSH plugin.

## Requirements

1. **Node ≥ 22** (DSH's own requirement)
2. **Bean Studio running**, with *Settings → MCP service* enabled (default `http://127.0.0.1:8766/mcp`)
3. Recordings already transcribed (untranscribed ones come back tagged `⚠未转写`)

## Install

```sh
dsh plugin add github:<your-account>/dsh-bean
```

To pin:

```sh
dsh plugin add github:<your-account>/dsh-bean#<commit>
```

## Config

Defaults are fine for most setups. To override, edit your profile's `cordis.patch.yml` (note: an override **replaces the whole config block**, so restate every key you need):

```yaml
- id: bean-studio
  config:
    endpoint: http://127.0.0.1:8766/mcp
    timeoutMs: 20000
    maxRecords: 5
```

## Tools

| Tool | Purpose |
|---|---|
| `bean_recall` | **Main entry.** Whole utterance in; parses time expressions + topic terms; returns snippets |
| `bean_search` | Explicit keywords, date range, scene filter |
| `bean_get` | Full transcript, summary, audio path for one recording |
| `bean_list` | Recordings newest-first |
| `bean_stats` | Count, total duration, last 7 days, scene mix, open todos |

Time expressions understood: 今天 / 昨天 / 前天 / 大前天 / 本周 / 上周 / 上上周 / 本月 / 上个月 / 最近 N 天 / 近 N 周 / 11月5号 / 5号.

## Why so thin

None of the retrieval logic lives here — it lives in Bean Studio's MCP server. This plugin is a forwarder. The reason is practical: **one implementation has to behave identically in dsh, Claude Code, Codex, and URL-only bots**. Several implementations eventually drift, and they drift in the worst way — by quietly returning nothing.

Deliberately chosen:

- **Zero imports, zero dependencies, zero build.** Only Node built-ins (`fetch`, `AbortSignal`). Plugins run inside the host process; every dependency is another way for the install to fail, and that failure surfaces on the client side as nothing more than "the plugin doesn't work".
- **Raw `ToolDefinition` registration** (`{ name, description, parameters, output, execute }`) instead of `defineTool`. Not a guess: `defineTool` internally calls `parameterSchemaSpecToJsonSchema()` to compile its property-map DSL into native JSON Schema, while `register()` and `projectToolSchema()` pass `parameters` through untouched. So a raw registration must hand over JSON Schema directly; handing over the DSL fails at registration. The cost is validating inputs in `execute` yourself.
- **Errors that tell you what to do.** An unreachable endpoint reports "open Bean Studio and check the MCP switch" instead of `ECONNREFUSED` — a dead backend is by far the most common failure.

## Development

```sh
git clone https://github.com/<your-account>/dsh-bean.git
cd dsh-bean
node test/smoke.mjs     # self-test: no DSH, no network required
dsh web --patch ./cordis.patch.yml
```

For source-mounted development, replace `name: dsh-bean` in `cordis.patch.yml` with a `file://` URL to `index.js` (Node ESM rejects raw Windows drive paths).

## Self-test

Two layers, neither needs an API key.

```sh
node test/smoke.mjs        # zero deps, no DSH install required
node test/contract.mjs     # validates tool definitions against the real @deepseek-ai/dsh-tools
```

`smoke.mjs` (70 checks): tool shape, purity of `render`/`presentCall` under malformed replay args, entry validation, unreachable-endpoint messaging, config clamping, and `package.json` ↔ `cordis.patch.yml` ↔ `locale` ↔ `icon` manifest coherence — every one of which otherwise fails silently as "installed but not active".

`contract.mjs` (32 checks) uses DSH's own functions to confirm three things that only break at runtime:

1. `output.schema` is inside the subset `assertSupportedJsonSchema()` accepts (checked on registration)
2. `parameters` is projected to the model **verbatim** by `projectToolSchema()` — i.e. it must be native JSON Schema, not the `defineTool` property-map DSL
3. `execute`'s real return value satisfies its own declared `output.schema`

Skips cleanly when `@deepseek-ai/dsh-tools` isn't resolvable; point it there with `DSH_TOOLS=<...>/dsh-tools/lib/index.js`.

## Limits

- The built-in Web Client **does not consume** `presentCall` / `presentResult`; results render as DSH's native tool row. A dedicated card (grouping, snippet highlight, jump-back-to-app) needs a Client plugin on the `tool.call.toolview` slot — see [`docs/UI.md`](docs/UI.md).
- Recall quality tracks transcription quality and library size.
- Bean Studio must be running. The plugin will not launch a desktop app behind your back.

## License

MIT
