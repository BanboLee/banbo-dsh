# dsh-llm-session-header

让 DeepSeek Harness 在每次调用 LLM 时，把当前会话（session）的 id 放进 HTTP 请求头里的插件。

它是 banbo-dsh 的第四个本地 bundle：注册一个新的 LLM provider 路由（默认 `light-session`），复用 pi-ai 的 **openai-completions** 线上实现，在每次请求里额外带上一个可配置的会话 header（默认 `x-session-id`）。这样你的自建网关（比如本地 `light` 网关）就可以把每一次 LLM 请求和它所属的 dsh 会话关联起来——无需改动 harness 内核、无需碰被锁死的 `sendSessionAffinityHeaders` 开关。

## 为什么需要它

Harness 官方有两条 LLM 通路：

- `@deepseek-ai/dsh-llm-deepseek`（`deepseek-official` 路由）：自带 `x-deepseek-harness-session-id` header，但请求体是 DeepSeek 官方风格（顶层 `thinking` 字段、`reasoning_effort` 上限 `max`），不适合标准 OpenAI-completions 网关。
- `@deepseek-ai/dsh-llm-pi-ai`（多 provider 路由）：是标准 OpenAI-completions 协议，但把 session id 写进 header 的开关（`compat.sendSessionAffinityHeaders`）被 harness **故意 withhold（禁止配置）**，且 profile 的 `headers` 只能是静态字符串，带不了动态的会话 id。

本插件用 harness 的公开扩展点 `ctx.llm.registerAdapter` 注册一个自定义 `LlmAdapter`，内部复用 pi-ai 的 `streamSimple`（`@earendil-works/pi-ai/compat` 公开导出、按 `model.api` 自动分发），在 `options.headers` 里注入动态会话 header——即保留了 pi-ai 的协议行为，又补上了动态 session id。

## 安装

```sh
cd ~/project/banbo-dsh
dsh plugin --profile dsh-tui add -w ./plugins/dsh-llm-session-header
```

## 配置

在 profile 的 `cordis.patch.yml` 或 `settings.yaml` 里给插件行配：

```yaml
- id: llm-session-header
  name: dsh-llm-session-header
  config:
    provider: light-session        # 要注册的 provider 路由名（默认 light-session）
    baseURL: http://10.37.14.42:55777/api/v2/light   # 你的网关地址
    apiKeyEnv: LIGHT_API_KEY       # API key 所在的环境变量名（默认 DEEPSEEK_API_KEY）
    sessionHeader: x-session-id    # 会话 header 名（默认 x-session-id）
    models:
      - id: gpt-5.5
        name: gpt-5.5
        contextWindow: 1000000
        maxTokens: 128000
      - id: gpt-5.6-sol
        contextWindow: 1000000
        maxTokens: 128000
    reasoning: high                # 可选：默认推理档位（默认不设，走 provider 默认）
    reasoningEfforts: [off, low, medium, high, xhigh, max]  # 可选：暴露的推理档位
```

### 字段说明

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `provider` | `light-session` | 注册的 provider 路由名。**不能**与 `llm-pi-ai` 已拥有的路由（如 `light`、`deepseek`）重名，否则 `DUPLICATE_ADAPTER`。 |
| `baseURL` | 必填 | 网关地址；请求打到 `{baseURL}/chat/completions`。 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 持有 API key 的环境变量名；未设置时请求以 `MISSING_CREDENTIAL` 失败。 |
| `sessionHeader` | `x-session-id` | 会话 header 的名字。只有请求带 `sessionId` 时才发送该 header（agent-loop 的正常请求都会带）。 |
| `models` | `[]` | 可选。声明模型元数据（名字、上下文、输出上限）供选择器和 `resolveModel` 使用；未声明的模型 id 仍会原样透传到网关。 |
| `reasoning` | 无 | 可选默认推理档位，作为该路由模型的 `defaultEffort`。 |
| `reasoningEfforts` | `[off, low, medium, high, xhigh, max]` | 可选。该路由暴露的推理档位列表；传 `[]` 表示不声明推理能力。 |

### 请求头

每次请求都会带上（与 harness 归因契约一致）：

```
user-agent: deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)
x-session-id: <当前会话 id>   # 仅当请求携带 sessionId 时
```

其它 header（`authorization`、`content-type`、`accept`）由 pi-ai 的 openai-completions 实现负责。

## 使用

装好后，把 dsh-tui / agent 的默认 provider 指向新路由即可：

```yaml
# settings.yaml
agent-default-model:
  provider: light-session
  model: gpt-5.5
```

之后每次调用 LLM，网关都能在请求头里读到 `x-session-id`。

## 行为细节

- **消息转换**：`GenerateOptions.messages` → pi-ai Context（文本、工具、工具结果、assistant 重放）。系统提示走 `options.system` → pi-ai 的 `systemPrompt` 槽；历史中的 system 消息折叠为 user 消息以保持顺序。图片块会以 `UNSUPPORTED_CONTENT` 风格错误拒绝（当前版本未实现图片上送）。
- **事件转换**：pi-ai 的 `AssistantMessageEventStream` → harness `StreamChunk`（text / reasoning / tool-call 增量、usage、finish）。工具参数从 pi-ai 的已解析对象序列化回 raw JSON 字符串。
- **错误映射**：把 pi-ai 的错误文案归类为 harness 的 `LlmError` code（`AUTH` / `RATE_LIMIT` / `INVALID_REQUEST` / `SERVER` / `TIMEOUT` / `TRANSPORT` 等）。
- **只支持 openai-completions**：内部固定使用 pi-ai 的 `openai-completions` 线上实现（与你 `light` 路由的 `api: openai-completions` 一致）。如果你还需要 `openai-responses` / `anthropic-messages`，需要扩展 `buildModel` 的 `api` 字段。

## 开发 / 测试

```sh
cd ~/project/banbo-dsh
env -u NODE_ENV npx vitest run plugins/dsh-llm-session-header
```

测试用一个本地 mock 网关（`tests/helpers.ts` 的 `mockGateway`）扮演 OpenAI-completions 端点，断言：

- 请求头带 `x-session-id`（可配置名字；无 sessionId 时不带）
- 请求体模型与消息正确、带 `stream: true`
- 带 harness 的 `user-agent` 归因头
- 文本 / 工具 SSE 事件被正确翻译成 harness chunk
- 缺 API key 时以 `MISSING_CREDENTIAL` 失败
- 推理档位透传、模型元数据解析

## 限制

- 仅支持文本 + 工具调用；图片上送未实现。
- 只复用 pi-ai 的 openai-completions 实现，不支持其它线上协议。
- provider 路由名不能与其它已注册路由冲突。
