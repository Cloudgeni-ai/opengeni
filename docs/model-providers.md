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
    | { kind: "deployment"; mechanism: "api_key" | "azure_ad_bearer" }
    | { kind: "connected_subscription"; provider: "codex" }
    | { kind: "workspace_connection"; mechanism: "api_key" };
  billing: {
    upstreamPayer: "deployment" | "workspace" | "connected_subscription";
    metering: "opengeni_credits" | "external";
  };
  capabilities: ModelCapabilitiesV1;
  pricing?: ModelPricingScheduleV1;
  definitionVersion: `sha256:${string}`;
}
```

The built-in OpenAI or Azure provider remains configured by the existing flat
settings. Additional providers are declared with
`OPENGENI_MODEL_PROVIDERS_JSON`.

## Registry configuration

Each registry provider declares a stable ID, one wire API, one base URL, its
credential location, and one or more model definitions:

```json
[
  {
    "id": "fireworks",
    "label": "Fireworks AI",
    "api": "chat",
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

Registry providers default to `kind: "api-key"` and `api: "chat"`. Prefer
`apiKeyEnv` to an inline `apiKey`. `defaultQuery` and `defaultHeaders` are
provider request configuration, not model identity aliases. Provider base URLs
must not contain userinfo, a query, or a fragment.

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
| Azure without an API key | deployment Azure AD bearer | deployment | OpenGeni credits |
| Connected Codex subscription | connected subscription | connected subscription | external |

`workspace_connection` is a reserved normalized contract. Generic JSON does
not enable workspace BYOK; that requires a separately reviewed encrypted
credential broker.

### Secret-safe definition versions

`definitionVersion` is a deterministic SHA-256 digest of executable model and
provider metadata. It changes when routing, wire API, execution limits,
capabilities, pricing, credential class, billing attribution, base URL, or an
explicitly public request-metadata value changes.

It does not include aliases, display labels, health, entitlement state, concrete
credential IDs, keys, tokens, or secret header/query values. Rotating a secret
within the same credential class therefore does not invalidate an accepted
turn. Changing executable provider identity does.

## Canonicalization and compatibility

`canonicalizeConfiguredModelId` accepts a canonical ID or an explicit alias.
New session, Send, Steer, scheduled-task, child-session, and workspace-policy
admission store canonical product IDs. Alias strings are retained only as
secret-safe requested-input evidence for an explicit per-turn switch.

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
- hosted web search, X search, and code execution;
- input and output modalities;
- SSE, Responses WebSocket, and realtime-audio transports; and
- standard, priority, and fast latency modes.

Upstream documentation alone never makes a capability runnable. For example,
provider support for X search or Responses WebSocket remains `runnable: false`
until OpenGeni has the request, recovery, and billing contracts to use it
safely. Capability metadata also never authorizes an OpenGeni tool; tool
discovery and authorization remain independent.

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
type ModelAvailabilityV1 = {
  status: "available" | "unavailable" | "degraded" | "unknown";
  selectable: boolean;
  reason:
    | "missing_credential"
    | "needs_reauth"
    | "not_entitled"
    | "provider_unhealthy"
    | "policy_blocked"
    | "unsupported"
    | null;
  checkedAt: string | null;
};
```

Selectability requires a runnable text definition, credential readiness, and
an allowing workspace model policy. A ready model with no current typed health
observation is `unknown` but selectable. Health and entitlement observations
are consumed as typed inputs owned by their respective subsystems; the catalog
does not invent them.

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

- OPE-12 owns normalized product/provider/deployment identity, credential and
  billing classification, capability metadata, availability projection, and
  the per-turn policy snapshot.
- Codex subscription account selection, leases, token refresh, allocator
  eligibility, capacity waiting, and portable compaction mechanics remain in
  their dedicated lifecycle/capacity owners.
- Health scoring and fleet pressure are observations consumed by the catalog,
  not computed here.
- Tool capability metadata never grants or discovers tools.