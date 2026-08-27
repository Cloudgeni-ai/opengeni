# Model and provider architecture

OpenGeni separates the model a user selects from the provider deployment that
serves it. This document is the canonical integration contract for model
definitions, provider credentials, billing attribution, workspace availability,
and per-turn execution identity.

The point-in-time decision record and evidence are in
[`design/model-provider-architecture-2026-07-18.md`](design/model-provider-architecture-2026-07-18.md).

## Identity layers

A configured model has four distinct identities:

1. **Product model ID** — stable ID stored on sessions and turns and exposed to
   clients, for example `xai/grok-4.5`.
2. **Alias** — compatibility input accepted at admission, for example
   `grok-4.5`. An alias is canonicalized once and is never sent upstream.
3. **Provider ID** — stable adapter and credential boundary, for example `xai`,
   `openai`, `azure`, or `codex-subscription`.
4. **Upstream model ID** — exact deployment slug sent to the provider, for
   example `grok-4.5`.

`packages/config/src/index.ts` normalizes every built-in and registry entry into
`ConfiguredModel`:

```ts
interface ConfiguredModel {
  schemaVersion: 1;
  id: string;
  aliases: string[];
  label: string;
  providerId: string;
  providerLabel: string;
  deployment: {
    upstreamModelId: string;
    wireApi: "responses" | "chat";
  };
  executionLimits: {
    contextWindowTokens: number | null;
    effectiveContextWindowTokens: number | null;
    autoCompactTokenLimit: number | null;
    toolOutputTruncationTokens: number | null;
  };
  credentialSource:
    | { kind: "deployment"; mechanism: "api_key" | "azure_ad_bearer" | "none" }
    | { kind: "connected_subscription"; provider: "codex" | "xai" }
    | { kind: "workspace_connection"; mechanism: "api_key" };
  billing: {
    upstreamPayer: "deployment" | "workspace" | "connected_subscription";
    metering: "opengeni_credits" | "external";
  };
  cost: "free" | "credits" | "subscription" | "workspace";
  capabilities: ModelCapabilitiesV1;
  pricing?: ModelPricingScheduleV1;
  definitionVersion: `sha256:${string}`;
}
```

The built-in OpenAI or Azure provider remains configured by the existing flat
settings. Additional providers are declared with
`OPENGENI_MODEL_PROVIDERS_JSON`.

## Deployment catalog source and cost policy

Catalog membership, workspace selectability, upstream settlement, and
workspace-facing cost are deliberately independent:

- `OPENGENI_MODEL_CATALOG_SOURCE=code` (default) uses the reviewed code/env
  catalog.
- `OPENGENI_MODEL_CATALOG_SOURCE=database` reads exactly one secret-free
  `deployment_model_catalog` row. Runtime is read-only and fails closed when the
  singleton is absent or invalid.
- Workspace policy, credential readiness, and health observations decide what
  is selectable. Neither source stores an `enabled` flag.
- `OPENGENI_MODEL_COST_POLICY_JSON` maps deployment product IDs to `free` or
  `credits`. Omitted deployment models are `credits`. Connected subscriptions
  and workspace Gateway models remain `subscription` and `workspace`.
- `OPENGENI_MODEL_PRICING_JSON` is separate again. A managed deployment that
  marks a model `credits` must provide a price when no reviewed built-in price
  exists, even if OpenGeni settles that provider through an external account.

Database documents use schema version 1 and contain only reviewed membership
and optional line-safe notes:

```json
{
  "schemaVersion": 1,
  "builtInModels": ["gpt-5.6-sol", "gpt-5.6-luna"],
  "registryProviders": [],
  "gatewayModels": [],
  "openrouterModels": [],
  "modelNotes": {
    "gpt-5.6-sol": "Use when the task is genuinely difficult."
  }
}
```

The strict document rejects keys, billing, pricing policy, enabled flags,
bands, unknown note IDs, duplicate product IDs, and reserved provider IDs.
Notes are at most 500 characters and cannot contain a newline or `|`.

For a database-source cutover, apply migration 0365, validate and upsert the
row with an admin/migration database credential, then roll API and workers with
the source flag. Do not flip the flag before the row exists:

```bash
OPENGENI_MIGRATIONS_DATABASE_URL='postgres://...' \
  bun run model-catalog:upsert -- --file ./model-catalog.json
```

The upsert increments `version` only when the normalized document changes. It
never writes provider credentials or the separate cost policy.

## Registry configuration

Each registry provider declares a stable ID, one wire API, one base URL, its
credential location, and one or more model definitions:

```json
[
  {
    "id": "fireworks",
    "label": "Fireworks AI",
    "api": "chat",
    "wireProfile": "openai",
    "baseUrl": "https://api.fireworks.ai/inference/v1",
    "apiKeyEnv": "OPENGENI_FIREWORKS_API_KEY",
    "models": [
      {
        "id": "accounts/fireworks/models/glm-5p2",
        "label": "GLM 5.2",
        "contextWindowTokens": 1048576,
        "reasoningEffort": true,
        "hostedWebSearch": false
      }
    ]
  }
]
```

Registry providers default to `kind: "api-key"`, `api: "chat"`, and
`wireProfile: "openai"`. Set `wireProfile: "azure-openai"` for another Azure
OpenAI resource: it keeps the ordinary OpenAI-compatible Responses transport
while applying Azure's stricter computer-call history normalization and native
Responses tool behavior. Prefer
`apiKeyEnv` to an inline `apiKey`. A provider that intentionally accepts public,
unauthenticated inference must set `kind: "anonymous"`; that kind rejects
`apiKey`, `apiKeyEnv`, and all configured default header/query metadata. This
keeps an operator from attaching an upstream session cookie or another hidden
credential while retaining external-metered billing. Missing a key on an
ordinary `api-key` provider remains a boot error. `defaultQuery` and
`defaultHeaders` are provider request configuration, not model identity aliases,
and are available only to authenticated provider kinds. Provider base URLs must
not contain userinfo, a query, or a fragment.

A registry model may add:

- `upstreamModelId` (defaults to the product `id`);
- `aliases`;
- raw, effective, auto-compaction, and tool-output token limits;
- the full `capabilities` object;
- flat pricing or an input-token-tiered pricing schedule.

Legacy `reasoningEffort` and `hostedWebSearch` booleans remain accepted. When a
full capability record is also present, the legacy booleans must agree with it.

Generic registry JSON cannot set `credentialSource` or `billing`. OpenGeni
derives both from the provider kind:

| Provider kind | Credential source | Upstream payer | Metering |
| --- | --- | --- | --- |
| Built-in or registry API key | deployment | deployment | OpenGeni credits |
| Anonymous registry route | deployment, no authentication | deployment | external |
| Azure without an API key | deployment Azure AD bearer | deployment | OpenGeni credits |
| Connected Codex subscription | connected subscription | connected subscription | external |
| Connected SuperGrok/xAI subscription | connected subscription | connected subscription | external |

`workspace_connection` is a reserved normalized contract. Generic JSON does
not enable workspace BYOK; that requires a separately reviewed encrypted
credential broker.

The table describes credential and upstream-settlement identity, not the
workspace-facing price. Deployment models—including anonymous and managed
OpenRouter routes—default to `credits` unless
`OPENGENI_MODEL_COST_POLICY_JSON` marks the exact product ID `free`. The picker
may still group such a route under External while the payment sentence and
`list_models` output show its deployment-defined cost.

### OpenCode Zen temporary free preview

OpenCode Zen currently exposes an OpenAI-compatible endpoint at
`https://opencode.ai/zen/v1`. On August 21, 2026, its public model registry
included `x-preview-f-free`, and that model accepted keyless Chat Completions,
Responses, SSE streaming, and function calls. OpenCode documents the Ox Alpha
free window as temporary, so configure it as an operator-owned registry entry
rather than treating it as a permanent built-in or availability promise:

```json
[
  {
    "kind": "anonymous",
    "id": "opencode-zen",
    "label": "OpenCode Zen",
    "api": "chat",
    "baseUrl": "https://opencode.ai/zen/v1",
    "models": [
      {
        "id": "opencode/x-preview-f-free",
        "upstreamModelId": "x-preview-f-free",
        "label": "OpenCode Ox Alpha (temporary free preview)",
        "contextWindowTokens": 1000000,
        "reasoningEffort": true,
        "hostedWebSearch": false
      }
    ]
  }
]
```

Requests go from OpenGeni to OpenCode's `opencode.ai` service; this is not local
inference. Anonymous routes are shown on the External rail. To make this
temporary preview free to the workspace, set
`OPENGENI_MODEL_COST_POLICY_JSON='{"opencode/x-preview-f-free":"free"}'`;
external settlement alone does not bypass credits. A free route still emits
ordinary model-call/token telemetry plus a zero-cost audit marker. It remains
subject to the upstream provider's changing
model catalogue, rate limits, retention policy, preview duration, and terms.
Verify `GET /zen/v1/models` before enabling the route and remove or update the
registry entry when keyless access or the model slug changes. OpenCode's
client-side model metadata advertises image input, but raw image probes on
August 21, 2026 returned upstream `503`/image-parse failures, so this example
deliberately keeps OpenGeni's runnable input capability at its text-only default.

OpenCode Zen uses the same provider-neutral progressive disclosure as other
ordinary Chat Completions providers. The first request receives the stable
`tool_search` and `tool_invoke` functions plus OpenGeni's always-visible base
tools and any explicitly eager MCP tools. Deferred MCP and other non-base tool
schemas stay out of the initial prompt; matching definitions are disclosed on
demand, and a valid invocation is rebound to the real authorized tool before
approval, guardrails, execution, and event handling. This needs only ordinary
function calling from Zen—no OpenCode-specific lazy-tool protocol.

OpenCode 1.18.21 also documented a client-side workaround for model responses
whose finish reason is `unknown`: continue the model loop instead of accepting
the response as final. OpenGeni handles the same signal at the generic Chat
Completions adapter boundary. It withholds `response_done`, executes no tool call
from the ambiguous response, and routes the same accepted turn through the
existing fenced recovery path from durable history. This is intentionally
narrower than blindly replaying every interrupted stream; ordinary partial or
outcome-unknown provider operations retain their existing safety classification.

Other Zen models use the same generic registry, but authentication and billing
ownership must stay explicit:

- Add another currently keyless model under the same `kind: "anonymous"`
  provider only after verifying that the exact slug accepts requests with no
  `Authorization` header.
- For deployment-managed paid Zen models, declare a separate `kind: "api-key"`
  provider (it may reuse the same base URL) with `apiKeyEnv` and reviewed model
  pricing/capabilities. The deployment owns the upstream account and OpenGeni
  meters those turns through the ordinary OpenGeni-credit path.
- A workspace member connecting their own OpenCode key/account is not generic
  registry JSON. That requires a reviewed encrypted workspace-connection broker,
  readiness/re-auth UI, and `upstreamPayer: workspace` external billing—the same
  authority boundary used by workspace AI Gateway.

Provider JSON is deliberately a static reviewed catalogue. OpenGeni does not
silently mirror `GET /models` into the picker because a mutable upstream list
does not supply stable product IDs, capability evidence, context limits,
pricing, billing ownership, or definition versions. An operator may use the
endpoint to prepare an update, but the accepted registry remains canonical.

## Curated AI Gateway models

`OPENGENI_VERCEL_AI_GATEWAY_API_KEY` enables two reviewed OpenGeni-credit
models. They are siblings of the built-in GPT-5.6 family in the OpenGeni picker
rail; the client never receives the Gateway hostname, upstream model slug, or
endpoint provider.

| Product | Approved provider order | Supplier input / cache read / output | Conservative retail fallback (+25%) |
| --- | --- | --- | --- |
| DeepSeek V4 Flash 0731 | Baseten → Novita → DeepInfra | Baseten $0.13 / $0.028 / $0.26; Novita $0.14 / $0.028 / $0.28; DeepInfra $0.09 / $0.018 / $0.18 per 1M | $0.175 / $0.035 / $0.35 per 1M (highest approved route) |
| Kimi K3 | Baseten → Fireworks | $3 / $0.30 / $15 per 1M on both routes | $3.75 / $0.375 / $18.75 per 1M |

Prices are a reviewed 2026-08-03 snapshot from public Gateway endpoint metadata.
Managed turns normally debit the exact Gateway-reported inference cost for the
provider that actually served the response, plus 25%. The static token rates
above are only a conservative fallback if that response metadata is absent.
Adding or changing a model requires reviewing the provider order, Responses
tool/vision transport, cache reporting, pricing, definition, and tests together.
Kimi's Gateway Responses adapter rejects grouped parallel call/result history.
At the post-serialization fence, OpenGeni pairs only complete call/result batches
by `call_id`. This preserves all fields and parallel execution; it does not
change the model or provider route. Grouped, name-annotated, and Chat Completions
continuations were probed on 2026-08-03; only the paired Responses shape kept
full tool continuity plus Gateway route/cost metadata.

Every Gateway request replaces caller routing options with the reviewed provider
list in both `only` and `order`, sends no model fallback list, and disables OpenAI
SDK retries. Gateway may advance only through that ordered allowlist. Unknown
Gateway model slugs fail before network I/O. Keep Gateway account-level rewrite
rules disabled for the managed key because those rules operate outside the
request body.

Both models request Gateway automatic caching. Kimi remains catalogued as
image-capable, so the worker also attaches `view_image` and `computer_*`
screenshot tools. DeepSeek stays text-only. OpenGeni verifies finalized
attachment bytes and checksums, then sends images inline as data URLs through
the standard Responses input surface; it never gives an endpoint provider an
object-store URL.

DeepSeek V4 Flash 0731 and Kimi K3 use OpenGeni's provider-neutral lazy-tool
dispatcher on the Responses wire. Their initial tool block contains the stable
ordinary `tool_search` and `tool_invoke` schemas, the always-visible base
runtime tools (`exec_command`, `write_stdin`, `apply_patch`, `view_image`,
`load_skill`, `request_human_input`, `list_models`), and exact session MCP refs marked
`eager: true`, never the deferred MCP catalogue or Browser/Computer/`generate_image`/
`generate_video`/`get_video_generation_capabilities` schemas. A search result carries only bounded
matching definitions. A valid `tool_invoke` call is renamed to the exact real authorized tool and
bound through `resolveMissingFunctionTool` in that same model response before
normal approval, guardrail, timeout, MCP error, and event handling. Leftover
historical registration items stay out of provider and user-visible history.
Provider history is restored to the original dispatcher call before every later
request—including exact stateless Responses replay, provider changes, lazy-mode
rollback, and compaction input.

A workspace admin can instead connect **Vercel AI Gateway** in workspace Settings.
The key is stored in the encrypted workspace connection table, resolved only in
the worker, and uses the same curated models and exact routes. These turns have
`upstreamPayer: workspace` and `metering: external`, so OpenGeni never debits
credits. The picker hides this rail until the connection is active.

Admins may also add one exact Vercel model slug at a time in the same Settings
card. The durable row stores only the workspace, slug, optional label, actor,
and timestamps. Custom IDs are `workspace-gateway/<slug>`; they receive the
reviewed generic text/function-calling Gateway capability envelope and no
provider pin, route order, pricing form, or upstream `/models` discovery.
Custom slugs may be prepared while disconnected, become selectable only after
the workspace Gateway connection is active and policy allows them, and are
available to session, automation, scheduled-task, and goal-continuation policy
resolution through the same workspace-scoped catalog overlay.

## Managed OpenRouter

`OPENGENI_OPENROUTER_API_KEY` enables a deployment-managed OpenRouter provider
at `https://openrouter.ai/api/v1`. It uses the generic OpenAI-compatible Chat
Completions dispatcher, public `X-Title` / optional `HTTP-Referer` metadata, and
deployment-owned credentials. No workspace OpenRouter connection exists.

The reviewed code catalog currently ships one v1 starter:

```text
openrouter/nvidia/nemotron-3-super-120b-a12b:free
```

On August 27, 2026, OpenRouter advertised that slug with a 262,144-token context
window, a 235,929-token completion ceiling, text input/output, function tools,
tool choice, structured outputs, and reasoning controls. A live forced-function
probe completed with `finish_reason=tool_calls`. OpenGeni therefore marks
function calling and structured output runnable, while reasoning effort remains
non-runnable until a reviewed effort vocabulary is mapped.

OpenRouter membership is curated and production never mirrors `GET /models`.
The v1 database schema accepts reviewed `:free` slugs only; a key does not make
every upstream model visible, and workspace policy may hide the starter. The
provider settles through the deployment's OpenRouter account and appears on the
External picker rail, while `OPENGENI_MODEL_COST_POLICY_JSON` independently
decides whether the workspace sees `free` or `credits`. The shipped default is
`free`. If an operator changes it to `credits`, managed billing also requires a
separate `OPENGENI_MODEL_PRICING_JSON` entry.

The generic dispatch path can carry future reviewed OpenRouter chat models,
but paid OpenRouter membership is intentionally not admitted by the v1 catalog
contract. For example, GLM 5.3 Flash was metadata-probed on August 27, 2026 but
is not shipped; adding it requires an explicit schema/catalog review, current
tool probe, capability definition, cost policy, and pricing decision.

## `list_models` agent tool

`list_models` is an always-visible, read-only local function with strict empty
arguments. It loads the current workspace catalog at execution time and uses
the same membership, connection-readiness, workspace-policy, and provider-health
decision as the human picker. Its result is one text string in catalog order:

```text
Current: gpt-5.6-sol
- openrouter/nvidia/nemotron-3-super-120b-a12b:free | Nemotron 3 Super 120B | free | Good for bounded tool-driven work.
- gpt-5.6-sol | GPT-5.6 Sol | credits
```

Each selectable line is `id | label | cost` with an optional final note. It
never returns keys, URLs, upstream IDs, prices, capabilities, definition
versions, or JSON. It does not switch the current session model; an agent uses
an ID with `session_create`, while humans use the model picker.

### Secret-safe definition versions

`definitionVersion` is a deterministic SHA-256 digest of executable model and
provider metadata. It changes when routing, wire API, wire profile, execution limits,
capabilities, pricing, credential class, billing attribution, base URL, or an
explicitly public request-metadata value changes.

It does not include aliases, display labels, health, entitlement state, concrete
credential IDs, keys, tokens, or secret header/query values. Rotating a secret
within the same credential class therefore does not invalidate an accepted
turn. Changing executable provider identity does.

Credential identity is also not a conversation-history compatibility boundary.
Changing the selected Codex or SuperGrok subscription does not rewrite canonical history or
a saved approval `RunState`. Responses providers receive canonical structured
items directly. Chat Completions receives one request-local transcript view for
canonical record types that its SDK converter cannot represent; that view is
never persisted. Historical `tool_search` calls/outputs remain inert completed
facts. A session frozen to `remote_v2` compaction admits only Codex models;
portable sessions may use any supported route whose request adapter can express
their canonical history. Responses output items may carry `status`
(`completed` / `in_progress` / `incomplete`); that field is not conversation
meaning — pairing is `call_id` — and Codex's input schema rejects it
(`400 Unknown parameter: 'input[N].status'`). New `session_history_items` rows
omit it at persist (`canonicalizePersistedHistoryItem`). The Codex request
normalizer still strips leftover item `id` and `status` on the wire for
already-stored SuperGrok rows and mid-turn SDK items — ordinary inference and
portable compaction share that seam — and never rewrites stored rows.

SuperGrok models use the `supergrok/` product namespace and the curated
`supergrok-subscription` provider. The catalog advertises image input, which is
the worker gate for user image attachments, `view_image`, and `computer_*`
screenshot tools. The xAI API-key rail remains separate. See
[`supergrok-subscription.md`](supergrok-subscription.md) for account authority,
allocator, lease, and durable capacity-wait semantics.

## Canonicalization and compatibility

`canonicalizeConfiguredModelId` accepts a canonical ID or an explicit alias.
New session, Send, Steer, scheduled-task, child-session, and workspace-policy
admission store canonical product IDs. Alias strings are retained only as
secret-safe requested-input evidence for an explicit per-turn switch.

An agent-spawned child that omits `model`, `reasoningEffort`, or `latencyMode`
inherits those fields from the exact worker-signed calling turn. Explicit child
values still win. The fallback for legacy session-bound grants is the parent
session, never the deployment default; consequently a Codex-subscription
manager cannot silently spawn an OpenGeni-credit worker merely by omitting
`model`.

Configuration fails loud when:

- two providers declare the same canonical product ID;
- an alias collides with a canonical ID or another alias;
- a model repeats an alias;
- a registry provider collides with the built-in provider ID; or
- provider JSON, URL, credential, capability, or pricing validation fails.

Unknown model inputs do not use alias fallback and must not silently route to a
different provider. `allowedModels` and the legacy `ClientModel` fields remain
in the public client contract. The normalized fields are additive and optional
at the protocol boundary so older clients and older payloads remain parseable.

## Capabilities: support is not runnability

Every capability records both upstream evidence and current OpenGeni adapter
runnability:

```ts
type CapabilityStateV1 = {
  upstream: "supported" | "unsupported" | "unknown";
  runnable: boolean;
};
```

The catalog describes:

- reasoning efforts, default, and whether reasoning is required;
- function calling and structured output;
- hosted web search, X search, code execution, and image generation;
- input and output modalities;
- SSE, Responses WebSocket, and realtime-audio transports; and
- standard, priority, and fast latency modes.

GPT-5.6 Sol, Terra, and Luna (including their Codex subscription variants)
advertise runnable **Fast** mode. Fast requests set the provider service tier,
use a 2× billing multiplier, and fail the turn if the provider response omits
or downgrades that tier; OpenGeni never silently falls back to Standard. The
same billed GPT-5.6 family pins Codex's 272,000 / 258,400 / 244,800
raw / effective / auto-compact catalog rather than the 1.05M deployment
fallback.

Upstream documentation alone never makes a capability runnable. For example,
provider support for X search or Responses WebSocket remains `runnable: false`
until OpenGeni has the request, recovery, and billing contracts to use it
safely. Capability metadata also never authorizes an OpenGeni tool; tool
discovery and authorization remain independent.

Hosted image generation is runnable only for reviewed direct OpenAI Responses
models. Connected Codex and workspace Gateway routes instead expose the same
provider-neutral client tool through separate paid-operation adapters. See
[`image-generation.md`](image-generation.md).

### Native web search is a runtime capability

Provider-native `web_search` is not an MCP catalog entry and is not governed by
the session's MCP allow-list. OpenGeni attaches native search whenever the
resolved provider declares hosted web search runnable, regardless of whether
the session uses workspace defaults or an explicit/inherited MCP policy.
Changing a session's connected or OpenGeni tools therefore cannot silently
disable web search.

`tool_search` is a different capability: it searches bounded lazy tool
schemas (deferred MCP plus every non-MCP function tool outside the
always-visible base set) so the model can discover them without preloading
every schema. It does not search the public web and must not be presented as a
fallback for native `web_search`.

Progressive disclosure is selected explicitly per resolved provider:

- **Codex subscription — `codex_native`:** native client `tool_search`; deferred
  schemas stay off the first-request tool block. A remembered authorized name
  binds through `resolveMissingFunctionTool` without requiring another search.
- **Built-in direct OpenAI/Azure Responses — `openai_native`:** the runtime keeps
  the original tool objects available to that same hook with the SDK deferred
  gate disabled, removes lazy schemas only from the provider request, and
  returns those same objects from native client `tool_search`.
- **Other ordinary function-calling providers — `generic_dispatch`:** the model
  receives stable ordinary `tool_search` and `tool_invoke` functions. No provider
  protocol extension is required. This includes an OpenAI-compatible custom base
  URL: configuring the built-in OpenAI slot does not prove native-search support.

Classification is origin, not transport. The same first-request set is eager on
every path: the closed non-MCP allowlist (`exec_command`, `write_stdin`,
`apply_patch`, `view_image`, `load_skill`, `request_human_input`, `list_models`) plus MCP
tools whose session `ToolRef.eager` is true. Every other function tool —
deferred MCP, Browser/Computer, `generate_image`, `generate_video`,
`get_video_generation_capabilities`, and later first-party additions — is
searchable on Codex, OpenAI, and generic dispatch alike. Native hosted image
generation stays a `hosted_tool` and is not in this function-tool hide set.
`ToolRef.eager` remains a per-session MCP choice and is untouched.

The sandbox's hosted-vs-function structured-tool setting does not select any of
these modes. `OPENGENI_CODEX_TOOL_SEARCH_ENABLED` controls only Codex native
disclosure. `OPENGENI_LAZY_TOOL_SEARCH_ENABLED` independently controls the
OpenAI/Azure native and generic paths; both settings default to enabled.

The execution registry and model-visible tools are deliberately separate.
Search never grants authority: every invocation resolves against the current
turn's already-authorized tool snapshot. Generic dispatch and native transports
accept a remembered authorized name after portable compaction without requiring
a fragile disclosure ledger; a removed, revoked, or malformed target returns a
typed model-visible error (`tool_unavailable` on generic `tool_invoke`, the
SDK not-found message on native) instead of killing the turn. The compacted
textual summary is never trusted as an exact schema store. Historical
generic-dispatch calls are restored independently of the current transport, so
switching providers cannot expose OpenGeni's internal execution rewrite.

Prompt-cache stability is a primary invariant. Generic control schemas,
descriptions, and ordering are constant, so adding, removing, or changing a
deferred MCP tool does not change the request's top-level tool block. The live
DeepSeek V4 Flash 0731 probe on 2026-08-07 reused 7,680 cached input tokens on
both post-search requests while completing search → invoke → final output.
Generic search results are also bounded before they enter ordinary tool-output
handling, so schema JSON is never silently middle-truncated.

The native tool uses the Agents SDK's bounded `medium` search-context setting
and preserves provider URL-citation annotations in structured conversation
history. It does not need a sandbox. If the resolved provider does not support
hosted search, or the provider search call fails, OpenGeni does not switch
providers, invoke an MCP connector, or run `curl` in a sandbox as a silent
fallback.

Existing explicit sessions are never widened automatically. An authorized
client can explicitly adopt the current workspace defaults through the
version-fenced session tool-policy endpoint; the change is audited and applies
from the next attempt:

```ts
const session = await client.getSession(workspaceId, sessionId);
await client.updateSessionToolPolicy(workspaceId, sessionId, {
  mode: "workspace_default",
  expectedVersion: session.toolPolicyVersion ?? 1,
});
```

A child may make this transition only while its immediate parent still tracks
workspace defaults. Use the original `{ tools, expectedVersion }` request when
the intent is an explicit fixed allow-list instead.

## Static catalog and workspace availability

`GET /v1/config/client` is public deployment bootstrap configuration. Its
`models` array exposes client-safe static definitions and the legacy
`allowedModels` list. It never contains workspace credential readiness,
workspace policy, concrete connected-account identity, or provider secrets.

Authenticated callers use:

```text
GET /v1/workspaces/:workspaceId/model-catalog
```

The route requires `workspace:read`, returns `cache-control: private, no-store`,
and adds availability to each static definition:

```ts
type ModelCredentialReadinessV1 = {
  status: "ready" | "not_ready" | "error";
  reason:
    | "missing_credential"
    | "needs_reauth"
    | "prerequisites_missing"
    | "resolver_error"
    | "observation_stale"
    | null;
  basis: "configuration" | "connection" | "resolver";
  checkedAt: string | null;
};

type ModelAvailabilityV1 = {
  status: "available" | "unavailable" | "degraded" | "unknown";
  selectable: boolean;
  reason:
    | "missing_credential"
    | "needs_reauth"
    | "credential_not_ready"
    | "not_entitled"
    | "provider_unhealthy"
    | "policy_blocked"
    | "unsupported"
    | null;
  checkedAt: string | null;
};
```

Workspace admins manage the hard allowlist from **Workspace Settings → Model
access**. The UI supports an unrestricted policy or an exact canonical model-id
allowlist, including future/custom IDs that are not yet present in the catalog.
It uses the existing model-policy routes through the typed SDK methods
`getWorkspaceModelAccessPolicy` and `updateWorkspaceModelAccessPolicy`:

```text
GET /v1/workspaces/:workspaceId/model-policy
PUT /v1/workspaces/:workspaceId/model-policy
```

Provider allowlists remain part of the API contract for advanced/operator use.
The authenticated catalog exposes only a per-model `policyAllowed` verdict, not
the provider identity that produced it. During a rolling upgrade, older API
instances may omit this additive verdict; the Settings editor then preserves
the existing provider rule and disables semantic replacement until a complete
projection is available. When an existing provider allowlist is opened with a
complete projection, it remains opaque and unchanged until an admin explicitly
confirms replacement; the admin then reviews the exact model IDs before saving
the new policy.

Credential readiness and provider availability are deliberately separate.
Static API-key presence proves only local configuration readiness; it is not a
provider-health probe. Codex readiness comes from the existing metadata-only
workspace connection lookup. Azure AD bearer and future workspace/federated
credentials require a successful typed resolver observation no more than five
minutes old. Missing, malformed, error, and stale resolver observations fail
closed and make the model unselectable. Catalog output never carries a token,
client or tenant ID, account/subscription identity, credential row ID,
federation subject/assertion, or raw provider error.

Blocker precedence is deterministic: an unsupported model definition wins,
then credential readiness, then workspace policy, then provider health or
entitlement. A ready, policy-allowed model with no current typed provider-health
observation is `unknown` but selectable. Observation timestamps describe only
the blocker that is actually returned; static/policy blockers do not borrow a
provider-health timestamp.

The current API route does not yet wire an Azure credential resolver and the
runtime has no `DefaultAzureCredential` or managed-identity token acquisition.
Consequently Azure AD bearer catalog entries fail closed as not ready even when
deployment configuration contains an explicit bearer token. Implementing and
wiring authoritative acquisition/refresh/readiness is separate work; catalog
discovery must not infer it from ambient Azure configuration or skill
activation.

The SDK method is:

```ts
client.getWorkspaceModelCatalog(workspaceId)
```

## Per-turn execution policy

Admission resolves the effective model and reasoning effort and persists a
strict, secret-safe policy in the logical turn's metadata:

```ts
type TurnExecutionPolicyV1 = {
  schemaVersion: 1;
  productModelId: string;
  requestedModelId: string | null;
  modelSource: "explicit" | "session" | "deployment" | "continuation";
  reasoningEffort: ReasoningEffort;
  reasoningSource: "explicit" | "session" | "deployment" | "continuation";
  providerId: string;
  upstreamModelId: string;
  wireApi: "responses" | "chat";
  credentialSource: CredentialSourceV1;
  billing: BillingAttributionV1;
  definitionVersion: string;
};
```

The metadata key is `turnExecutionPolicyV1`. Only an absent key is a legacy
turn. A present `null`, `undefined`, unknown schema version, extra field, or
otherwise malformed value fails closed. Parsing errors identify invalid paths
without reflecting untrusted values.

Create admission uses `deployment` sources for omitted values and `explicit`
sources for caller-supplied values. Follow-up admission uses the session's
durable model and reasoning preference when omitted. An explicit alias records
the raw requested ID but persists and executes its canonical product ID.

The same logical turn keeps the same policy across approval resume, capacity
waiting, retries, and worker recovery. A new logical turn resolves current
configuration again. Execution verifies the snapshot against the exact turn
model/reasoning and current executable definition before provider work; drift
must fail rather than silently switch provider, credential class, billing
owner, or deployment.

Audit events and idempotent receipts use a minimal projection: requested and
effective model, inheritance sources, reasoning effort, provider ID, credential
class, billing attribution, and definition version. They never include a key,
token, concrete connected credential, authorization header, or
credential-bearing URL.

## Runtime routing and billing

`packages/runtime/src/model-provider.ts` is the canonical package-private facade
for the runtime provider surface. Cohesive sibling leaves own client/transport
construction (`model-provider-client.ts`), typed failures
(`model-provider-errors.ts`), object-stage request policy
(`model-provider-request-policy.ts`), and provider-bound model construction plus
name routing (`model-provider-routing.ts`). Gateway HTTP fallback and shared
model-call detection live in `model-provider-transport.ts`. The package root
re-exports only the facade surface for compatibility; none of the leaves is a
public package subpath.

`MultiProviderModelProvider` is installed as the process default so both
in-process and sandboxed agent paths resolve the same product model. A resolved
provider-bound model is constructed with the normalized
`deployment.upstreamModelId`, not the public product ID or alias.

- `responses` providers use `OpenAIResponsesModel`.
- `chat` providers use `OpenAIChatCompletionsModel`.
- An unresolved `codex/<slug>` fails with a connection-specific error rather
  than falling through to OpenAI or Azure.
- Workspace policy is rechecked against canonical provider/product identity at
  the execution boundary.

Portable compaction is provider-independent conversation lifecycle, not a
model capability. The summarizer uses the same resolved provider and wire API
as the turn while the durable replacement algorithm remains shared.

Pricing is keyed by product model ID. A tiered schedule selects the greatest
`minimumInputTokens` threshold not exceeding the current input count. Billing
classification comes from the accepted policy: `external` usage must not spend
OpenGeni model credits; `opengeni_credits` usage follows configured pricing and
margin rules.

### Price audit (llm-prices canary)

OpenGeni debit authority is the hand-maintained
`defaultModelPricing` map in `packages/config/src/index.ts` (plus registry /
`OPENGENI_MODEL_PRICING_JSON` overrides). Do not generate that map from an
external feed.

When you add a billed model or want to verify list rates are still current:

```bash
bun run check:model-pricing
```

That fetches [llm-prices.com](https://www.llm-prices.com/current-v1.json) and
compares Standard short- and long-context rates for the allow-listed GPT-5.6
product ids. Treat mismatches as a prompt to re-check OpenAI (or the provider)
and update `defaultModelPricing` — not as automatic truth to import.

Not covered by the llm-prices canary: Fast/priority multipliers, Fireworks GLM
defaults, the provider-pinned Gateway snapshots, and the `marginBps` markup.
Gateway catalogue tests pin the exact Baseten/Wafer rates and caching claims;
offline llm-prices coverage uses
`scripts/fixtures/llm-prices-current-v1.sample.json`.

## Evidence-bounded Grok 4.5 support

Grok 4.5 is supported only as an explicitly configured deployment through
xAI's official API:

```text
product model:  xai/grok-4.5
alias:          grok-4.5
provider:       xai
upstream model: grok-4.5
base URL:       https://api.x.ai/v1
wire API:       responses
credential:     deployment API key
billing:        deployment / OpenGeni credits
context:        500,000 tokens
```

The evidence-backed definition exposes reasoning (`low`, `medium`, `high`,
default `high`, required), function calling, structured output, text/image
input, text output, hosted web search, and SSE as runnable. X search, code
execution, Responses WebSocket, and priority service remain non-runnable until
their OpenGeni contracts exist. Realtime audio is unsupported for this model.

Standard pricing below 200,000 input tokens is $2/M input, $0.30/M cached input,
and $6/M output. At 200,000 or more input tokens it is $4/M input, $0.60/M
cached input, and $12/M output.

Source support does not make Grok visible by default. The host must configure
the xAI registry provider and an authorized API key. No authorized xAI
credential was available during this implementation, so tests prove parsing,
routing, catalog projection, capability gating, and the exact 199,999/200,000
pricing boundary—not live entitlement or production inference.

Cursor model availability is not a raw xAI credential path. Cursor Cloud
Agents and its SDK are a separate agent-runtime integration with Cursor-owned
credentials and billing; Cursor subscription capacity is not modeled as an
xAI/OpenAI inference credential.

## Verification

Provider architecture changes should run, at minimum:

```bash
bun test packages/contracts/test/contracts.test.ts
bun test packages/config/test/model-providers.test.ts
bun test packages/runtime/test/model-providers.test.ts
bun test apps/api/test/model-catalog.test.ts
bun test packages/sdk/test/client-coverage.test.ts packages/sdk/test/contract-parity.test.ts
bun run check:docs-refs
```

Run the package-local typechecks for every affected package and the workspace
typecheck before release. Database-backed policy persistence tests require the
repository PostgreSQL test database. Live provider checks require an
already-authorized credential and must keep secrets out of logs and fixtures.

## Ownership boundaries

- The provider architecture owns normalized product/provider/deployment
  identity, credential and billing classification, capability metadata,
  availability projection, and the per-turn policy snapshot.
- Codex subscription account selection, leases, token refresh, allocator
  eligibility, capacity waiting, and portable compaction mechanics remain in
  their dedicated lifecycle/capacity owners.
- Health scoring and fleet pressure are observations consumed by the catalog,
  not computed here.
- Tool capability metadata never grants or discovers tools.
