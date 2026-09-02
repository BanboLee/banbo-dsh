# dsh-llm-pi-ai-with-session

一个给 DeepSeek Harness 的 LLM 调用加上「会话（session）标识」能力的插件：在每次 LLM 请求的 HTTP 头里带上当前会话 id，方便自建网关把请求和 dsh 会话关联起来。

它是 `llm-pi-ai` 的一个**通用 session wrapper**：只为配置中显式声明的 provider 注册 session 路由，复用 pi-ai 的 **openai-completions** 线上实现，在每次请求里额外带上一个可配置的会话 header（默认 `x-session-id`）。网关、模型、凭据、静态 headers、推理档位全部从 source provider **继承**，无需重复配置——不含任何环境特定内容，无需改动 harness 内核、无需碰被锁死的 `sendSessionAffinityHeaders` 开关。

## 为什么需要它

Harness 官方有两条 LLM 通路：

- `@deepseek-ai/dsh-llm-deepseek`（`deepseek-official` 路由）：自带 `x-deepseek-harness-session-id` header，但请求体是 DeepSeek 官方风格（顶层 `thinking` 字段、`reasoning_effort` 上限 `max`），不适合标准 OpenAI-completions 网关。
- `@deepseek-ai/dsh-llm-pi-ai`（多 provider 路由）：是标准 OpenAI-completions 协议，但把 session id 写进 header 的开关（`compat.sendSessionAffinityHeaders`）被 harness **故意 withhold（禁止配置）**，且 profile 的 `headers` 只能是静态字符串，带不了动态的会话 id。

本插件用 harness 的公开扩展点 `ctx.llm.registerAdapter` 注册一个自定义 `LlmAdapter`，内部复用 pi-ai 的 `streamSimple`（`@earendil-works/pi-ai/compat` 公开导出、按 `model.api` 自动分发），在 `options.headers` 里注入动态会话 header——既保留 pi-ai 的协议行为，又补上动态 session id。

> 它不修改官方 `llm-pi-ai` provider，也不全局拦截 fetch；它通过公开的 `ctx.llm.registerAdapter` 注册独立 session 路由。每条 session 路由都显式声明 `source`，并从 `ctx.settings.get('llm-pi-ai')` 读取对应 source provider 的配置。

## 安装

```sh
cd ~/project/banbo-dsh
dsh plugin --profile <profile> add -w ./plugins/dsh-llm-pi-ai-with-session
```

## 配置

**通用配置（网关、凭据、模型、推理档位）只写一份**——就在 `llm-pi-ai` 的 providers 里。插件自身只声明需要生成哪些 session 路由，以及会话 header 名；其余一切（baseURL、apiKeyEnv、headers、models、reasoning、reasoningEfforts）都从 source provider 继承：

```yaml
# settings.yaml —— llm-pi-ai 的 providers 是唯一的事实来源
llm-pi-ai:
  providers:
    deepseek:
      apiKeyEnv: DEEPSEEK_API_KEY
      baseURL: http://gateway.example.com/v1
      reasoning: max
      api: openai-completions
      models:
        - id: deepseek-v4-flash
        - id: deepseek-v4-pro
    light:
      apiKeyEnv: LIGHT_API_KEY
      baseURL: http://gateway.example.com/v1
      reasoning: xhigh
      api: openai-completions
      models:
        - id: gpt-5.5
          name: gpt-5.5
          contextWindow: 1000000
          maxTokens: 128000

# 插件段：只声明 session route；baseURL/apiKeyEnv/models/reasoning 一律不写
llm-pi-ai-with-session:
  sessionHeader: x-session-id
  routes:
    - route: light-session
      source: light
      displayName: Light (session)
```

装好后，只有 `routes` 中声明的路由会注册。上例只注册 `light-session`，不会自动生成 `deepseek-session`，因此模型选择器不会因为本插件把所有 provider 翻倍。

### 字段说明

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `sessionHeader` | `x-session-id` | 会话 header 的名字。请求没有 `sessionId` 时会失败，不会静默发送无会话请求。 |
| `routes[].route` | 必填 | 注册到 Harness 的 session provider 路由名。 |
| `routes[].source` | 必填 | 继承配置的 `llm-pi-ai.providers.<source>`。 |
| `routes[].displayName` | `route` | 模型选择器显示名，建议加上 `(session)` 与原 provider 区分。 |

插件没有 `suffix`、`reasoning`、`reasoningEfforts` 配置——**路由名只来自 `routes[].route`，推理能力从 source provider 继承**：默认档位取 source provider 的 `reasoning`，可选档位取 source 模型声明的 `reasoningEfforts` dict（未声明时用默认列表 `[off, low, medium, high, xhigh, max]`，`false` 表示禁用推理）。`baseURL`、`apiKeyEnv`、`headers`、`models` 同样从 `ctx.settings.get('llm-pi-ai')` 的对应 provider 逐条继承，模型元数据（name/contextWindow/maxTokens）取自 source provider 的 models 表。若 settings namespace 未注册、providers 为空或 routes 为空，插件以零路由 dormant 启动，不报错。

### 请求头

每次请求都会带上（与 harness 归因契约一致）：

```
user-agent: deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)
x-session-id: <当前会话 id>   # 仅当请求携带 sessionId 时
```

source provider 的静态 `headers` 会一起发送；若静态 headers 与会话 header 同名，请求的真实 session id 会覆盖静态值。其它 header（`authorization`、`content-type`、`accept`）由 pi-ai 的 openai-completions 实现负责。

## 使用

装好后，把 dsh-tui / agent 的默认 provider 指向某条会话路由即可：

```yaml
# settings.yaml
agent-default-model:
  provider: light-session
  model: gpt-5.5
```

之后每次调用 LLM，网关都能在请求头里读到 `x-session-id`。会话模型选择器里只会出现配置中声明的 session 路由。

## 行为细节

- **显式路由**：插件在 apply 时读取 `ctx.settings.get('llm-pi-ai')` 的 providers，只注册 `routes` 中声明的路由；网关（baseURL）、凭据（apiKeyEnv）、静态 headers、模型表、推理能力全部继承自 source provider。声明的 source 不存在时插件加载失败；未声明的路由由 Harness 以 `NO_ADAPTER` 拒绝。
- **消息转换**：`GenerateOptions.messages` → pi-ai Context（文本、工具、工具结果、assistant 重放）。系统提示走 `options.system` → pi-ai 的 `systemPrompt` 槽；历史中的 system 消息折叠为 user 消息以保持顺序。图片内容在发请求前被显式拒绝（`UNSUPPORTED_CONTENT`），不会静默丢弃（assistant 图片同样拒绝，作为纵深防御）。
- **事件转换**：pi-ai 的 `AssistantMessageEventStream` → harness `StreamChunk`（text / reasoning / tool-call 增量、usage、finish）。工具参数从 pi-ai 的已解析对象序列化回 raw JSON 字符串。
- **错误映射**：把 pi-ai 的错误文案归类为 harness 的 `LlmError` code——上下文超限归 `CONTEXT_WINDOW_EXCEEDED`（触发 harness 自动压缩）、配额/余额耗尽归 `QUOTA`、`429`/限流归 `RATE_LIMIT`，其余按 `AUTH` / `INVALID_REQUEST` / `SERVER` / `TIMEOUT` / `TRANSPORT` 归类。
- **推理档位**：完全继承源 provider——默认档位取 provider 级 `reasoning`，可选档位取模型级 `reasoningEfforts` dict（其 wire spelling 原样透传给 pi-ai，所以 `xhigh` / `max` 会真实发送，不会被钳到 `high`）；模型未声明时用默认列表，`false` 禁用推理。
- **只支持 openai-completions**：内部固定使用 pi-ai 的 `openai-completions` 线上实现。如果你还需要 `openai-responses` / `anthropic-messages`，需要扩展 `buildModel` 的 `api` 字段。

## 开发 / 测试

```sh
cd ~/project/banbo-dsh
env -u NODE_ENV npx vitest run plugins/dsh-llm-pi-ai-with-session
```

测试用本地 mock 网关（`tests/helpers.ts` 的 `mockGateway`）扮演 OpenAI-completions 端点，断言：

- 请求头带 `x-session-id`（可配置名字；无 sessionId 时请求失败）
- 请求体模型与消息正确、带 `stream: true`
- 带 harness 的 `user-agent` 归因头
- 文本 / 工具 SSE 事件被正确翻译成 harness chunk
- 显式路由注册：只有配置中声明的 route 会注册，显示名可与 source provider 区分
- 按 provider 分发：各路由请求打到各自的网关、用各自的 api key
- 缺 API key 时以 `MISSING_CREDENTIAL` 失败；未镜像路由以 `NO_ADAPTER` 失败
- 推理能力继承：默认档位取源 provider 的 `reasoning`，可选档位取源模型的 `reasoningEfforts` dict
- settings 集成路径：stub `llm-pi-ai` namespace + 内存 settings provider，验证从 settings 镜像

## 限制

- 仅支持文本 + 工具调用；图片上送未实现，图片输入会以 `UNSUPPORTED_CONTENT` 显式拒绝。
- 只复用 pi-ai 的 openai-completions 实现，不支持其它线上协议。
- 只注册配置中声明的 route，不能与其它已注册路由冲突。
- 依赖 `llm-pi-ai` 的 settings namespace 已注册（含 providers）；未注册或为空时插件 dormant，不提供任何路由。
