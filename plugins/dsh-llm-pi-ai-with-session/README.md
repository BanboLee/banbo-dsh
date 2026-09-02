# dsh-llm-pi-ai-with-session

一个给 DeepSeek Harness 的 LLM 调用加上「会话（session）标识」能力的插件：在每次 LLM 请求的 HTTP 头里带上当前会话 id，方便自建网关把请求和 dsh 会话关联起来。

它是 `llm-pi-ai` 的一个**通用 session wrapper**：自动**镜像 llm-pi-ai 的全部 providers**，为每个 provider 派生一条会话路由（默认 `<provider>-session`），复用 pi-ai 的 **openai-completions** 线上实现，在每次请求里额外带上一个可配置的会话 header（默认 `x-session-id`）。网关、模型、凭据、推理档位全部从被镜像的 provider **继承**，无需重复配置——不含任何环境特定内容，无需改动 harness 内核、无需碰被锁死的 `sendSessionAffinityHeaders` 开关。

## 为什么需要它

Harness 官方有两条 LLM 通路：

- `@deepseek-ai/dsh-llm-deepseek`（`deepseek-official` 路由）：自带 `x-deepseek-harness-session-id` header，但请求体是 DeepSeek 官方风格（顶层 `thinking` 字段、`reasoning_effort` 上限 `max`），不适合标准 OpenAI-completions 网关。
- `@deepseek-ai/dsh-llm-pi-ai`（多 provider 路由）：是标准 OpenAI-completions 协议，但把 session id 写进 header 的开关（`compat.sendSessionAffinityHeaders`）被 harness **故意 withhold（禁止配置）**，且 profile 的 `headers` 只能是静态字符串，带不了动态的会话 id。

本插件用 harness 的公开扩展点 `ctx.llm.registerAdapter` 注册一个自定义 `LlmAdapter`，内部复用 pi-ai 的 `streamSimple`（`@earendil-works/pi-ai/compat` 公开导出、按 `model.api` 自动分发），在 `options.headers` 里注入动态会话 header——既保留 pi-ai 的协议行为，又补上动态 session id。

> 它并不挂载或依赖 `llm-pi-ai` 插件本身，而是直接复用 `@earendil-works/pi-ai` SDK，在 `ctx.settings.get('llm-pi-ai')` 上读取 llm-pi-ai 已解析的 providers 并逐条镜像。因此你可以把 `llm-pi-ai` 插件禁用（其 npm 包保留即可，作为 pi-ai SDK 的来源），只要它的 settings namespace 仍在提供 providers。

## 安装

```sh
cd ~/project/banbo-dsh
dsh plugin --profile <profile> add -w ./plugins/dsh-llm-pi-ai-with-session
```

## 配置

**通用配置（网关、凭据、模型、推理档位）只写一份**——就在 `llm-pi-ai` 的 providers 里，插件自动镜像，不在插件段重复。插件自身**只配会话 header 名**（可选，默认 `x-session-id`），其余一切（baseURL、apiKeyEnv、models、reasoning、reasoningEfforts）都从被镜像的 source provider 继承：

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

# 插件段：只配会话 header 名；baseURL/apiKeyEnv/models/reasoning 一律不写
llm-pi-ai-with-session:
  sessionHeader: x-session-id   # 会话 header 名（默认 x-session-id；通常可以整段省略）
```

装好后，llm-pi-ai 的每个 provider 都会派生一条会话路由 `<provider>-session`：`deepseek-session`、`light-session`……它们与源 provider 行为一致，只是每次请求额外带 `x-session-id`。

### 字段说明

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `sessionHeader` | `x-session-id` | 会话 header 的名字。只有请求带 `sessionId` 时才发送该 header（agent-loop 的正常请求都会带）。 |

插件没有 `suffix`、`reasoning`、`reasoningEfforts` 配置——**路由名固定 `<provider>-session`，推理能力从源 provider 继承**：默认档位取 source provider 的 `reasoning`，可选档位取 source 模型声明的 `reasoningEfforts` dict（未声明时用默认列表 `[off, low, medium, high, xhigh, max]`，`false` 表示禁用推理）。`baseURL`、`apiKeyEnv`、`models` 同样从 `ctx.settings.get('llm-pi-ai')` 的对应 provider 逐条继承，模型元数据（name/contextWindow/maxTokens）取自源 provider 的 models 表。若 llm-pi-ai 未注册或 providers 为空，插件以零路由 dormant 启动，不报错。

### 请求头

每次请求都会带上（与 harness 归因契约一致）：

```
user-agent: deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)
x-session-id: <当前会话 id>   # 仅当请求携带 sessionId 时
```

其它 header（`authorization`、`content-type`、`accept`）由 pi-ai 的 openai-completions 实现负责。

## 使用

装好后，把 dsh-tui / agent 的默认 provider 指向某条会话路由即可：

```yaml
# settings.yaml
agent-default-model:
  provider: light-session
  model: gpt-5.5
```

之后每次调用 LLM，网关都能在请求头里读到 `x-session-id`。会话模型选择器里会出现全部派生路由（`deepseek-session`、`light-session`……），随时可切。

## 行为细节

- **自动镜像**：插件在 apply 时读取 `ctx.settings.get('llm-pi-ai')` 的 providers，每个 provider `<p>` 注册一条 `<p>-session` 路由；网关（baseURL）、凭据（apiKeyEnv）、模型表、推理能力全部继承自源 provider。路由名不匹配（如未镜像的名字）以清晰错误拒绝。
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

- 请求头带 `x-session-id`（可配置名字；无 sessionId 时不带）
- 请求体模型与消息正确、带 `stream: true`
- 带 harness 的 `user-agent` 归因头
- 文本 / 工具 SSE 事件被正确翻译成 harness chunk
- 多 provider 镜像：每个源 provider 派生一条 `<name>-session` 路由
- 按 provider 分发：各路由请求打到各自的网关、用各自的 api key
- 缺 API key 时以 `MISSING_CREDENTIAL` 失败；未镜像路由以 `NO_ADAPTER` 失败
- 推理能力继承：默认档位取源 provider 的 `reasoning`，可选档位取源模型的 `reasoningEfforts` dict
- settings 集成路径：stub `llm-pi-ai` namespace + 内存 settings provider，验证从 settings 镜像

## 限制

- 仅支持文本 + 工具调用；图片上送未实现，图片输入会以 `UNSUPPORTED_CONTENT` 显式拒绝。
- 只复用 pi-ai 的 openai-completions 实现，不支持其它线上协议。
- 派生路由名固定为 `<provider>-session`，不能与其它已注册路由冲突。
- 依赖 `llm-pi-ai` 的 settings namespace 已注册（含 providers）；未注册或为空时插件 dormant，不提供任何路由。
