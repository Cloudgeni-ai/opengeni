# Decision models

Decision models are a shared category of typed inference, separate from chat and
the conversational model picker. A model judges common input against named
**predicate**, **choice** or **score** questions; it does not write an agent answer.
`@opengeni/decisions` owns the interface and OpenAI/OpenRouter HTTP adapters.
`@opengeni/jev` adapts its existing TypeSafe client to that interface.

Two consumers use it:

- Tool discovery judges the wider lexical shortlist, then resolves only exact
  authorized candidate identities. Exact names and strong lexical matches bypass
  inference. Unconfigured, invalid or unavailable judgments recover through the
  normal best-match-first lexical path. Cancellation propagates.
- `code_search` uses the same interface for file, passage, symbol and evidence
  judgments. Its existing rubrics, workspace access and session-frozen offering
  remain. It does **not** silently substitute keyword scores after a refusal or
  outage; its existing error/recovery and breaker policy remain.

## Deployment configuration

Configure all three explicitly, on API and worker servers:

```dotenv
OPENGENI_DECISION_MODEL_PROVIDER=openrouter
OPENGENI_DECISION_MODEL_ID=typesafe/jev-1.13
OPENGENI_DECISION_MODEL_API_KEY=<server-side credential>
```

This enables paid selection for ambiguous tool searches. Code search also requires
its existing `OPENGENI_CODE_SEARCH_MODE` and workspace/session setting. No paid
model is configured by default. No customer key or subscription is borrowed.
Partial explicit configuration is unavailable; it never falls back to a different
credential. Configure the category as one deployment change.

| Provider | Model example | Endpoint | Optional base URL |
| --- | --- | --- | --- |
| `jev` | `jev-1.13` | Existing TypeSafe `/v1/systemone` | `https://api.typesafe.ai` |
| `openai` | `gpt-6-luna` | OpenAI `/v1/decisions` | `https://api.openai.com/v1` |
| `openrouter` | `typesafe/jev-1.13` or `openai/gpt-6-luna-decisions` | OpenRouter `/api/alpha/decisions` | `https://openrouter.ai/api/alpha` |

The override is `OPENGENI_DECISION_MODEL_BASE_URL`; adapters append their endpoint
path. Leave it unset for official endpoints. Model IDs are provider-native IDs,
not IDs resolved through the ordinary chat-model registry. OpenRouter's Decisions
models need not appear in its normal chat `/models` response.

Legacy `OPENGENI_JEV_API_KEY/BASE_URL/MODEL/REQUEST_TIMEOUT_MS` still serve existing
code-search deployments when **no** shared category setting is present. They never
silently enable paid tool discovery. The existing Jev timeout/chunking/retries and
code-search breaker values are unchanged; no new cap, timeout or quota is added.
Embedders can pass a `DecisionModel` as `BuildAgentOptions.toolSearchDecisionModel`
and the same instance as `runCodeSearch({decisionModel, ...})`.

## Verified boundaries (October 21, 2026)

- **OpenRouter typed endpoint:** live predicate/choice/score probes succeeded for
  both Jev and Luna. Tool-discovery evals ran on returned versions
  `typesafe/jev-1.13-20260917` and `openai/gpt-6-luna-decisions-20261006`.
  Jev was the stronger and cheaper selector on these catalogs; it is the recommended
  optional backend. No-model remains the free default. See the
  [complete measurements and limitations](../scripts/tool-discovery-eval/README.md).
- **Direct TypeSafe:** existing client is reused and mocked end to end; no direct
  key was available for this evaluation. OpenRouter Jev results are not a direct
  TypeSafe latency or billing measurement.
- **Direct OpenAI:** adapter matches the official typed contract and has mocked
  wire tests. No Platform key was available for a live successful call.
- **Codex subscription:** a real saved, unexpired local ChatGPT/Codex login was
  checked in place, not copied from a deployment host. The actual Codex models
  route returned 200 and entitled Luna. Ordinary Codex Responses with Luna returned
  200 and completed (1.62 s in one smoke probe). The same access token sent to
  Platform `/v1/decisions` returned 401, “A valid API key is required.” The correctly
  headed Codex `/backend-api/codex/decisions` request returned JSON 404. Thus ordinary
  Luna through Codex works, but the fast typed endpoint did not work on the tested
  routes. This is not a proof about every deployment account or future endpoint,
  and ordinary Luna prose/JSON judging is not presented as the Decisions API.

No successful live native-tool-search protocol matrix is claimed by these probes.
Native OpenAI/Azure/Codex discovery remains native; SDK replay and wire continuity
tests cover that separate boundary.

## Usage, failures and caches

Usage carries actual returned model/provider, nullable input/output tokens,
successful chunk count, nullable USD and its source. OpenRouter costs are reported
receipts; the direct Jev adapter retains the client's input-cost estimate. Direct
OpenAI cost is unknown unless the caller supplies an explicit estimate rate.
Published input pricing is not substituted for a missing billed receipt. HTTP
adapters record received usage before rejecting malformed answers; failed requests
without receipts have unknown cost, not zero. Partial successful code-search
stages are recorded even when a later stage fails. Historical replay never re-bills
or reruns inference.

`tool_discovery.*` and `code_search.decision_*` are deployment telemetry, **not
customer-credit debits**. The worker does not call model-usage settlement. The
usage-event debit trigger covers knowledge-query embedding events, not these
categories. External hosts may apply their own accounting policy. Code-search
metrics and event names now use `decision` rather than `jev`; update external
dashboards that consume the old names.

HTTP adapters distinguish unavailable/auth/billing/rate-limit/server failures from
rejected requests and never return raw provider bodies to the main agent. They
validate complete typed answers. No endpoint automatically falls back to chat
completions or another account. Selection cannot grant execution authority.

The configured backend does not change model-facing tool descriptions per turn.
Search selections are frozen on their originating call, then disclosed only after
its result. Native hosted search and historical definitions are preserved.
This draft's static prompt/control-schema changes cause one cache-prefix change at
upgrade; later results and catalog changes never rewrite earlier prompt items.

## Sources

- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
- [OpenRouter Decisions SDK contract](https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README.md)
- [OpenRouter OpenAPI](https://openrouter.ai/openapi.json), operation-level server
  and `/api/alpha/decisions` path

The advertised roughly 150 ms / 10× speed claim is not the observed end-to-end
latency of our candidate batches. Use the measured numbers, not that claim, for
configuration decisions.
