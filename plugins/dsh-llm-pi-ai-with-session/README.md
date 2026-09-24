# @banbolee/dsh-llm-pi-ai-with-session

**English** | [中文](./README.zh.md)

A plugin that adds **session identity** to DeepSeek Harness LLM calls: every LLM
request carries the current session id in an HTTP header, so your own gateway
can correlate requests with dsh sessions.

It is a **generic session wrapper** over the official `llm-pi-ai` adapter: it
registers explicit session provider routes — only the routes declared in
`routes` — that reuse pi-ai's **openai-completions** wire implementation and add
one configurable session header (default `x-session-id`) to every request.
Gateway, credentials, static headers, models, and reasoning tiers are all
**inherited** from the source provider in `llm-pi-ai.providers`; nothing is
duplicated. It uses only the public `ctx.llm.registerAdapter` extension point,
never modifies harness core, needs no extra binary, and never touches the
locked-down `sendSessionAffinityHeaders` switch.

## Why this plugin exists

Harness ships two official LLM paths:

- `@deepseek-ai/dsh-llm-deepseek` (the `deepseek-official` route): it already
  sends an `x-deepseek-harness-session-id` header, but its request body follows
  the DeepSeek official shape (a top-level `thinking` field, `reasoning_effort`
  capped at `max`), which does not fit a standard OpenAI-completions gateway.
- `@deepseek-ai/dsh-llm-pi-ai` (multi-provider routes): it speaks the standard
  OpenAI-completions protocol, but the switch that writes the session id into a
  header (`compat.sendSessionAffinityHeaders`) is **deliberately withheld by
  harness (configuration refused)**, and a profile's `headers` can only be
  static strings, so they cannot carry a dynamic session id.

This plugin registers a custom `LlmAdapter` through the public
`ctx.llm.registerAdapter` extension point. Internally it reuses pi-ai's
`streamSimple` (a public export of `@earendil-works/pi-ai/compat` that
dispatches on `model.api`) and injects the dynamic session header into
`options.headers` — keeping pi-ai's protocol behavior while adding the dynamic
session id.

> It does not modify the official `llm-pi-ai` provider and does not intercept
> fetch globally; it registers independent session routes through the public
> `ctx.llm.registerAdapter`. Every session route declares its `source`
> explicitly and reads that source provider's configuration from
> `ctx.settings.get('llm-pi-ai')`.

## Install

**Install from npm (recommended)** — no clone needed:

```sh
dsh plugin --profile <profile> add @banbolee/dsh-llm-pi-ai-with-session
```

For local development, install from the repository root:

```sh
cd ~/project/banbo-dsh
dsh plugin --profile <profile> add -w ./plugins/dsh-llm-pi-ai-with-session
```

## Config

**The shared configuration — gateway, credentials, models, reasoning tiers,
retry, and timeouts — is written exactly once**, in `llm-pi-ai`'s providers.
The plugin itself only declares which session routes to create and the session
header name; everything else (baseURL, apiKeyEnv, headers, models, reasoning,
reasoningEfforts, retryPolicy, timeoutMs, streamIdleTimeoutMs) is inherited from
the source provider:

```yaml
# settings.yaml — llm-pi-ai's providers are the single source of truth
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
          input: [text, image]

# Plugin section: declare session routes only; never write baseURL/apiKeyEnv/models/reasoning
llm-pi-ai-with-session:
  sessionHeader: x-session-id
  routes:
    - route: light-session
      source: light
      displayName: Light (session)
```

Once installed, only the routes declared in `routes` are registered. The example
above registers `light-session` only and does not automatically create
`deepseek-session`, so the plugin never doubles every provider in the model
picker.

### Field reference

| Field | Default | Meaning |
| --- | --- | --- |
| `sessionHeader` | `x-session-id` | Name of the session header. A request without a `sessionId` fails instead of silently sending a session-less request. |
| `routes[].route` | required | Session provider route name registered with Harness. |
| `routes[].source` | required | The `llm-pi-ai.providers.<source>` entry the configuration is inherited from. |
| `routes[].displayName` | `route` | Model picker display name; adding `(session)` is recommended so it is distinguishable from the original provider. |

The plugin has no `suffix`, `reasoning`, or `reasoningEfforts` configuration —
**the route name comes only from `routes[].route`, and reasoning and input
modalities are inherited from the source provider**: the default tier comes from
the source provider's `reasoning`, and the selectable tiers come from the
`reasoningEfforts` dict declared on the source model (when it is not declared,
the default list `[off, low, medium, high, xhigh, max]` is used, and `false`
disables reasoning). Input modalities resolve in this order: a non-empty `input`
on the source model, pi-ai's built-in catalog, the provider's `defaultInput`,
then `[text]`. Image models use Harness's persistent attachment service to
produce request images bounded by pixel and byte budgets; historical images
beyond the request budget keep their usable read-only attachment paths. For text
models, Harness projects the images in every role into stable text placeholders.
`baseURL`, `apiKeyEnv`, `headers`, and `models` are likewise inherited field by
field from the matching provider in `ctx.settings.get('llm-pi-ai')`. If the
settings namespace is not registered, providers is empty, or routes is empty,
the plugin starts dormant with zero routes and reports no error.

### Retry and timeouts (inherited since 0.1.2)

A session route's **retry policy, request timeout, and streaming idle timeout**
are likewise inherited from the source provider's `retryPolicy` / `timeoutMs` /
`streamIdleTimeoutMs`, resolved exactly the way the official `llm-pi-ai`
resolves them:

- `retryPolicy`: resolved when the route is registered and handed to harness's
  `dsh-llm-retry` for execution; when unset it matches the official behavior —
  normal mode with 5 retries by default.
- `timeoutMs`: passed through to the underlying pi-ai / SDK as the per-request
  timeout.
- `streamIdleTimeoutMs`: applied to stream reads by this plugin through the same
  `idleWatchdog` the official adapter uses; an idle timeout maps to a `TIMEOUT`
  error (a retryable error code). When unset it defaults to 5 minutes
  (300000ms), the same as the official default.

Changing these three fields in settings.yaml takes effect **hot**: `timeoutMs` /
`streamIdleTimeoutMs` use the new values on the next request, and `retryPolicy`
re-registers the routes automatically by subscribing to `settings/updated` — no
restart required.

### Request headers

Every request carries the following (matching harness's attribution contract):

```
user-agent: deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)
x-session-id: <current session id>   # only when the request carries a sessionId
```

The source provider's static `headers` are sent as well; if a static header has
the same name as the session header, the request's real session id overrides the
static value. The other headers (`authorization`, `content-type`, `accept`) are
handled by pi-ai's openai-completions implementation.

## Usage

Once installed, point the default provider used by dsh-tui or an agent at one of
the session routes:

```yaml
# settings.yaml
agent-default-model:
  provider: light-session
  model: gpt-5.5
```

From then on every LLM call carries `x-session-id` in its request headers, so
the gateway can read it. The session model picker shows only the session routes
declared in the configuration.

## Behavior

- **Explicit routes**: at apply time the plugin reads the providers from
  `ctx.settings.get('llm-pi-ai')` and registers only the routes declared in
  `routes`; the gateway (baseURL), credentials (apiKeyEnv), static headers,
  model table, and reasoning capabilities are all inherited from the source
  provider. A declared source that does not exist makes plugin loading fail; a
  route that was never declared is rejected by Harness with `NO_ADAPTER`.
- **Message conversion**: `GenerateOptions.messages` → a pi-ai Context (text,
  user images, tools, tool results, assistant replay). The system prompt goes
  through `options.system` → pi-ai's `systemPrompt` slot; system messages in the
  history are folded into user messages to preserve order. Image models read a
  deterministic request version through the persistent attachment service and
  prefix each image with its attachment identity, actual request dimensions, and
  usable read-only paths; system or assistant images that pi-ai cannot replay
  are rejected with `UNSUPPORTED_CONTENT`. For text models, Harness projects the
  images in every role into stable text placeholders before adapter dispatch.
- **Event conversion**: pi-ai's `AssistantMessageEventStream` → harness
  `StreamChunk` (text / reasoning / tool-call deltas, usage, finish). Tool
  arguments are serialized from pi-ai's parsed object back into a raw JSON
  string.
- **Error mapping**: pi-ai error text is classified into harness `LlmError`
  codes — an exceeded context window becomes `CONTEXT_WINDOW_EXCEEDED` (which
  triggers harness auto-compaction), exhausted quota/balance becomes `QUOTA`,
  `429`/rate limiting becomes `RATE_LIMIT`, and everything else is classified as
  `AUTH` / `INVALID_REQUEST` / `SERVER` / `TIMEOUT` / `TRANSPORT`.
- **Reasoning tiers**: fully inherited from the source provider — the default
  tier comes from the provider-level `reasoning`, and the selectable tiers come
  from the model-level `reasoningEfforts` dict (their wire spelling is passed
  through to pi-ai unchanged, so `xhigh` / `max` are really sent and never
  clamped to `high`); when a model declares nothing the default list is used, and
  `false` disables reasoning.
- **openai-completions only**: the wire implementation is pinned to pi-ai's
  `openai-completions`. If you also need `openai-responses` /
  `anthropic-messages`, you have to extend `buildModel`'s `api` field.

## Development / testing

```sh
cd ~/project/banbo-dsh
env -u NODE_ENV npx vitest run plugins/dsh-llm-pi-ai-with-session
```

The tests use a local mock gateway (the `mockGateway` in `tests/helpers.ts`) to
play the OpenAI-completions endpoint, and assert that:

- request headers carry `x-session-id` (a configurable name; a request without a
  sessionId fails)
- the request body carries the right model and messages, with `stream: true`
- harness's `user-agent` attribution header is present
- text / tool SSE events are translated correctly into harness chunks
- explicit route registration: only the routes declared in the configuration are
  registered, and the display name can be distinguished from the source provider
- per-provider dispatch: each route's requests hit its own gateway with its own
  api key
- a missing API key fails with `MISSING_CREDENTIAL`; a route that is not mirrored
  fails with `NO_ADAPTER`
- reasoning capability inheritance: the default tier comes from the source
  provider's `reasoning`, and the selectable tiers come from the source model's
  `reasoningEfforts` dict
- image capability inheritance: once the source model declares
  `input: [text, image]`, the request body contains images and still keeps the
  dynamic session header
- the settings integration path: a stubbed `llm-pi-ai` namespace plus an
  in-memory settings provider verify mirroring from settings

## Limitations

- Image models only send the images in user messages and in their tool results;
  system and assistant images cannot be replayed by pi-ai and are rejected with
  `UNSUPPORTED_CONTENT`. For text models, Harness projects all historical images
  into text placeholders up front.
- Only pi-ai's openai-completions implementation is reused; no other wire
  protocol is supported.
- Only the routes declared in the configuration are registered, and they must
  not collide with any other registered route.
- It depends on the `llm-pi-ai` settings namespace being registered (including
  providers); when that namespace is unregistered or empty the plugin stays
  dormant and provides no routes.
- Advanced profile fields are not inherited yet: `compat`, `transport`,
  `cacheRetention`, `thinkingBudgets`, `modelOverrides`,
  `websocketConnectTimeoutMs`, and others still use pi-ai's default behavior;
  they can be aligned field by field when needed.
