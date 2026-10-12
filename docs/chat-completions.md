# Single model calls (Chat Completions)

Opengeni exposes a stateless, OpenAI-compatible Chat Completions endpoint for
single model calls: one request, one model response, no tools and no agent
loop. It routes the call through the workspace's model catalog, so one client
can reach every connected provider (API keys, gateways, and subscription
accounts) with the same request shape. Anything agentic (tools, multi-step
work, sandboxes, history) uses sessions instead.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /v1/workspaces/{workspaceId}/chat/completions` | One model call; JSON or server-sent-event streaming. |
| `GET /v1/workspaces/{workspaceId}/models` | The workspace models the caller may use, in OpenAI list shape. |

Both require a credential with `sessions:create` in the workspace (the same
permission as composer transcription). A stock OpenAI client works when
pointed at the workspace base URL:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENGENI_ACCESS_KEY,
  baseURL: `${process.env.OPENGENI_URL}/v1/workspaces/${workspaceId}`,
});
const completion = await client.chat.completions.create({
  model: "codex/gpt-6-luna",
  messages: [{ role: "user", content: "Translate to Norwegian: good morning" }],
});
```

`model` is a workspace catalog model ID (as returned by `/models`); omit it to
use the workspace default for new work. A model the caller cannot use returns
`404 model_not_found`, exactly like an unknown one.

## Supported request

- `messages` with roles `system`, `developer` (treated as system), `user` and
  `assistant`. User messages may contain `text` and `image_url` parts (image
  parts only for models with image input); other roles take text.
- `max_tokens` / `max_completion_tokens`, `temperature`, `top_p`, `stop`,
  `reasoning_effort` (clamped to the model's supported efforts), `verbosity`.
- `response_format: { type: "json_schema", json_schema: { name, schema, strict? } }`
  for models that declare structured output. `text` is accepted as a no-op.
- `stream: true`, with `stream_options.include_usage` for a final usage chunk.

Some backends do not take every control. The Codex subscription backend
ignores `temperature`, `top_p` and the output-token limits (its request
allowlist drops them, as for agent turns) and honors `json_schema` output on
reviewed GPT-6 models. A provider that cannot apply `stop` refuses it with
`400 unsupported_parameter`.

Refused with `400 unsupported_parameter` naming the parameter: `tools`,
`tool_choice`, `functions`, `function_call`, `web_search_options`, `audio`,
`prediction`, `tool`/`function` messages and assistant `tool_calls`,
`logprobs`/`top_logprobs`, `logit_bias`, non-zero penalties, `n > 1`,
`store: true`, non-text `modalities`, and `response_format: json_object`
(use `json_schema`). Unknown fields are ignored, as OpenAI clients expect.

Errors use the OpenAI error envelope
(`{ "error": { "message", "type", "code", "param" } }`). In a stream, a failure
before the first output chunk is a normal JSON error response; a failure after
output started is sent as an in-band `error` event before `[DONE]`. A client
disconnect cancels the upstream request.

## Execution

The API process handles the call directly: no session, turn, Temporal workflow
or sandbox is created, and prompts and outputs are not stored. One shared
runtime function, `runSingleModelCall` (`packages/runtime/src/single-model-call.ts`),
makes the request on whichever wire the model uses (Responses, Chat
Completions, or native Claude Messages). Session title generation uses the same
function.

Workspace and organization model credentials apply exactly as for turns.
Subscription-backed models are supported:

- **Codex:** the call takes a sessionless `completion` operation lease on an
  eligible shared Codex connection and reserves each upstream request against
  it, like transcription. A single call only runs on an account whose included
  usage is known to be available; it never spends paid extra usage, and
  returns `429 subscription_usage_exhausted` when no account qualifies.
- **Claude subscription:** the call uses the workspace's Claude connection
  credential selection, as turns do.
- **SuperGrok:** the call uses the workspace's xAI subscription connection.

An unavailable subscription returns `503 subscription_unavailable` or
`503 subscription_reconnect_required`.

## Billing

- Admission only requires a positive credit balance for credit-billed models;
  it is never sized from `max_tokens`.
- Actual usage is settled once per call, keyed by a server-generated request
  ID (`model_call:{requestId}`), with the same pricing and attribution as turn
  model usage. Subscription and customer-credential calls cost no Opengeni
  credits but still record usage.
- There are no endpoint-specific rate limits; provider limits surface as
  `429 provider_rate_limited`.

## Title generation

Session titles are a single call made by the worker with the turn's own
provider route. On a subscription the title stays on the same account:

- Codex subscription turns title with `codex/gpt-6-luna`.
- Claude subscription turns title with Claude Haiku 5.5 on the turn's
  credential.
- Other turns use the configured title model as before.

## Code map

| Concern | Source |
| --- | --- |
| Wire parsing and response shapes | `apps/api/src/model-calls/chat-completions.ts` |
| Routes and streaming | `apps/api/src/routes/chat-completions.ts` |
| Model resolution, admission, subscriptions, settlement | `apps/api/src/model-calls/service.ts` |
| Provider-neutral single call | `packages/runtime/src/single-model-call.ts` |
| Admission and settlement | `packages/core/src/billing/model-call-admission.ts`, `packages/core/src/billing/model-usage-settlement.ts` |
| Title route | `apps/worker/src/activities/agent-turn/session-title.ts` |
