# dsh-bean

[![test](https://github.com/Valentin106/dsh-bean/actions/workflows/test.yml/badge.svg)](https://github.com/Valentin106/dsh-bean/actions/workflows/test.yml)

把**本地录音库**接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）。

在对话里问一句「上周聊定价的那段说了什么」，命中的录音原文就直接回到上下文里 —— 不用打开 App，不用翻列表，不用掏设备。

配套的录音库本体是 **Bean Studio**（安克录音豆 D3200 的桌面端，本地私有项目，未开源）：负责录音、本地转写（faster-whisper，离线免费）、按「时间 + 主题」召回。本仓库只是把它变成一个 DSH 插件。

```
你：上周三跟渠道那边聊定价，最后定了个什么数？
dsh → bean_recall({ query: "上周三跟渠道那边聊定价" })
     ↓ 时间词解析：上周三 → 11-04；主题词：定价 / 渠道 / 聊
     ↓ 时间窗内逐条打分：标题 3.0 / 摘要 2.0 / 正文 1.0，再乘时间衰减
     ← 命中 1 条，取正文里密度最高的一段（约 200 字）
dsh：你们最后说的是首年 6 折、次年回到 7.5 折，渠道要求把返点从 8% 提到 10%……
     （来自 #21《渠道定价沟通》 11-04 15:20 ｜ 会议 ｜ 38分12秒）
```

## 前置条件

1. **Node ≥ 22**（DSH 本身的要求）
2. **Bean Studio 在运行**，且「设置 → MCP 服务」是打开状态（默认 `http://127.0.0.1:8766/mcp`）
3. 录音已经转写过（未转写的记录召回时会被标 `⚠未转写`）

## 安装

```sh
dsh plugin add github:Valentin106/dsh-bean
```

> 插件会在安装时把 `cordis.patch.yml` 作为一层配置插进 profile。装完用 `dsh --dump-config` 能看到 `id: bean-studio` 这一行，再用 `dsh` 正常启动即可。

想钉版本：

```sh
dsh plugin add github:Valentin106/dsh-bean#<sha>
```

这套安装路径是实测过的（`dsh 0.2.2-rc.1`，`pnpm 12`）：

```
$ dsh plugin --profile bean add ./dsh-bean-0.1.0.tgz
+ dsh-bean 0.1.0

$ dsh --profile bean --dump-config
# == dsh-bean
- id: bean-studio
  name: dsh-bean
  config:
    endpoint: http://127.0.0.1:8766/mcp
```

两个踩过的坑写在 `test/smoke.mjs` 里当回归断言，不是过时注释：

- `package.json` 一旦声明 `exports`，**必须**同时导出 `./package.json`。插件管理器解析 bundle 时要读它，漏了会在依赖已装好的情况下报 `cannot resolve profile bundle`。
- 开发期挂源码要用 `file://` URL，不能直接写 `C:\...`（Node ESM 会把盘符当协议）。

## 配置

默认值对大多数人够用，要改就在 profile 的 `cordis.patch.yml` 里覆盖（注意：**覆盖会整块替换 config，要重述所有需要的键**）：

```yaml
- id: bean-studio
  config:
    endpoint: http://127.0.0.1:8766/mcp   # 录音豆 MCP 端点
    timeoutMs: 20000                       # 单次调用超时
    maxRecords: 5                          # 单次最多回几条，压住上下文占用
```

## 工具

| 工具 | 用途 | 何时被调 |
|---|---|---|
| `bean_recall` | **主入口**。整句原话进，自动解析时间词 + 主题词，返回原文片段 | 用户说「那段」「聊过」「说过」 |
| `bean_search` | 显式关键词 + 日期范围 + 场景过滤 | 用户自己给了明确条件 |
| `bean_get` | 取某条录音全文、摘要、音频路径 | 召回后要看完整内容 |
| `bean_list` | 按时间倒序列出录音 | 「我最近都录了什么」 |
| `bean_stats` | 总条数、总时长、近 7 天、场景分布、未完成待办 | 概览 |

时间词支持：今天 / 昨天 / 前天 / 大前天 / 本周 / 上周 / 上上周 / 上月 / 本月 / 最近 N 天 / 近 N 周 / 11月5号 / 5号。

## 为什么这么薄

检索逻辑一行都不在本仓库里 —— 它在 Bean Studio 的 MCP server 里。这个插件只做一层转发。原因很实际：**同一套解析，要在 dsh、Claude Code、Codex、以及只认 URL 的 bot 里表现完全一致**。各写一份，迟早会有一处对不上，而且对不上的方式通常是「安静地什么都没查出来」，最难查。

同样地，刻意选择了：

- **零 import、零依赖、零构建**。只用 Node 内置的 `fetch` / `AbortSignal`。插件跑在 host 进程里，多一个依赖就多一个装不上的可能，而这类故障在客户端侧只表现为「插件不生效」。
- **裸 `ToolDefinition` 注册**（`{ name, description, parameters, output, execute }`），不走 `defineTool`。这条不是拍脑袋：`defineTool` 内部会调 `parameterSchemaSpecToJsonSchema()` 把「属性映射 DSL」编译成原生 JSON Schema，而 `register()` 和 `projectToolSchema()` 对 `parameters` 是**原样透传、不做编译**。所以裸注册的 `parameters` 必须直接写 JSON Schema —— 写了 DSL 会在注册期被当成属性名解析而抛错。代价是入口自己校验参数（`query` 不能空、`id` 必须是正整数），少一条包解析路径。
- **报错要说人话**。端点连不上时不抛 `ECONNREFUSED`，而是告诉你「先打开 Bean Studio，确认设置里 MCP 是开的」—— 插件最常见的故障就是本体没启动。

## 本地开发

不用发版，直接把源码挂进 DSH：

```sh
git clone https://github.com/Valentin106/dsh-bean.git
cd dsh-bean
node test/smoke.mjs          # 自检，不需要 DSH，也不需要联网

dsh web --patch ./cordis.patch.yml
```

开发期挂源码，需要把 `cordis.patch.yml` 里的 `name: dsh-bean` 换成 `index.js` 的**绝对路径**（ESM 规范要求 Windows 路径先转成 `file://` URL）：

```powershell
node -e "const {pathToFileURL}=require('node:url');console.log(pathToFileURL(process.argv[1]).href)" "$PWD\index.js"
```

```yaml
- insert:
    - id: bean-studio
      name: 'file:///C:/path/to/dsh-bean/index.js'
```

## 自检

两层，都不需要 API Key。

```sh
node test/smoke.mjs        # 零依赖，不用装 DSH
node test/contract.mjs     # 对着真实的 @deepseek-ai/dsh-tools 校验工具定义
```

**`smoke.mjs`**（70 项）覆盖：工具注册形状（名字/描述/schema/render）、`render` 与 `presentCall` 的纯函数性与脏输入健壮性（会话回放不能炸）、入口参数校验、端点不可达时的报错文案、配置边界夹紧、以及 `package.json` ↔ `cordis.patch.yml` ↔ `locale` ↔ `icon` 的清单一致性 —— 这几处错任何一条，表现都是「装上了但没生效」，最难自查。录音豆在跑时再附带一次真实调用。

```
PASS 70   FAIL 0   SKIP 0        # 录音豆在跑
PASS 65   FAIL 0   SKIP 1        # 没跑，真实调用那一段整段跳过
```

**`contract.mjs`**（32 项）用 DSH 自己的函数确认三件事，都是运行期才会炸、事后极难定位的：

1. `output.schema` 落在 `assertSupportedJsonSchema()` 支持的子集内（注册时当场校验）
2. `parameters` 被 `projectToolSchema()` 原样投影给模型 —— 即「这里写的是原生 JSON Schema」这个判断成立
3. `execute` 的真实返回值满足自己声明的 `output.schema`（不满足 = 模型已经决定调用之后才报 isError）

```
PASS 32   FAIL 0        # 录音豆在跑；没跑时 28，跳过返回值校验
```

找不到 dsh-tools 时自动 SKIP，不影响 `smoke.mjs` 的零依赖定位。指定路径：

```sh
DSH_TOOLS=<...>/node_modules/@deepseek-ai/dsh-tools/lib/index.js node test/contract.mjs
```

## 验证过什么

不想只交付「应该能跑」。下面每一条都是对着真实 `dsh 0.2.2-rc.1` + `pnpm 12` 实测的：

| 环节 | 实测结果 |
|---|---|
| 安装 | `dsh plugin --profile bean add ./dsh-bean-0.1.0.tgz` → profile 的 `dsh.profile.bundles` 自动追加 `dsh-bean` |
| 从 GitHub 安装 | `dsh plugin add github:Valentin106/dsh-bean` → `+ dsh-bean 0.1.0`，拉取约 1 分钟，配置层结果与 tarball 装法一致 |
| 配置层 | `dsh --profile bean --dump-config` → 配置树出现 `id: bean-studio` 及其 config |
| 加载 | 真实 `dsh web` 进程内 `apply` 执行，`ctx.tools.schemas()` 里能查到 5 个 `bean_*` 工具 |
| 工具契约 | 模型可见的 `bean_recall.parameters` 与源码里写的 JSON Schema **逐字一致**（`description` 中文原文、`required`、`additionalProperties` 都在） |
| 返回值 | `execute` 对着真实录音库返回的值，通过 DSH 自己的 `validateJsonSchemaValue` 校验 |

最后两行是重点：`parameters` 一致说明「裸注册 + 原生 JSON Schema」这条路线成立，不需要 `defineTool`。

## 已知限制

- 内置 Web Client **不消费** `presentCall` / `presentResult`，所以现在的结果就是 DSH 原生的工具结果行。想要专门的卡片（分组、片段高亮、点一下跳回 App 那条录音），需要额外做一个 Client 插件占用 `tool.call.toolview` 槽位，见 [`docs/UI.md`](docs/UI.md)。
- 召回质量取决于转写质量与录音库体量；库里只有 1 条的时候它当然只能回那 1 条。
- 依赖 Bean Studio 在跑。插件不会替你拉起它（静默启动一个桌面程序不是插件该做的事）。

## License

MIT
