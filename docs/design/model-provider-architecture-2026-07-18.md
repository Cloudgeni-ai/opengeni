<!-- docs-refs: record -->

> **Point-in-time architecture decision.** Written and reviewed against the exact
> baseline below. Current code and canonical topic documentation supersede paths or
> implementation details after this record is accepted and implemented.

# ADR: Explicit model, provider, credential, billing, and turn policy

- **Status:** Proposed; implementation is blocked until an independent architecture review approves this exact revision
- **Date:** 2026-07-18
- **Baseline:** `a906a06881036b7d005ab33940f5ec6c91938482`
- **Issue:** Linear OPE-12
- **Owner:** OPE-12 Model Provider Architecture
- **Review:** Independent Sol/xhigh reviews of `7a86fb08909045e79207193a8f97d88afaa021f5`
  and `0efab9bff651f33907f7b29e127989cce835cbfa` requested changes; this
  revision addresses those findings and still requires exact-head approval
  before implementation

## Context

OpenGeni already has useful multi-provider and per-turn seams:

- deployment-configured OpenAI/Azure models and extra OpenAI-compatible registry
  providers are projected by `configuredModels()`;
- a connected Codex subscription is injected as a workspace-local synthetic
  provider;
- the API rejects unknown models and OPE-35 workspace policy rejects blocked
  provider/model selections before enqueue, while the worker repeats the policy
  check after runtime resolution and before any model call;
- `sessions.model`, `session_turns.model`, and
  `session_turns.reasoning_effort` persist session preference and accepted-turn
  execution values; and
- goal continuations inherit the newest turn that durably emitted `turn.started`,
  while approval resume, capacity wait, and worker-loss recovery reuse the same
  turn row.

Those seams are not yet one explicit product contract:

1. `ConfiguredModel.id` is both the user-facing product selection and the exact
   string sent upstream. A deployment rename therefore changes durable product
   identity.
2. `ResolvedModelProvider` combines provider identity, credential mechanism, and
   client construction. The only credential kinds are `api-key` and
   `codex-subscription`.
3. Billing ownership is derived from Codex-specific routing state rather than a
   model/provider contract. A future externally billed provider could therefore
   be charged as OpenGeni-managed usage.
4. Reasoning and hosted web search are booleans. The catalog cannot express
   supported reasoning levels, a required/default reasoning mode, function
   calling, structured output, latency/priority modes, streaming transport, or
   the difference between Responses WebSocket and realtime voice/audio.
5. Definition, credential readiness, provider health, workspace availability,
   and OPE-35 policy are not distinct concepts in the client catalog.
6. A turn freezes `model` and reasoning effort, but its provider/deployment and
   billing interpretation are re-resolved from mutable configuration on every
   attempt. Recovery cannot silently change `model`, but a catalog edit could
   change what that product string means.
7. An omitted follow-up reasoning effort currently falls back to the deployment
   default, not the durable session preference stored at creation. Composer and
   admission can therefore disagree.
8. The durable foreground command audit identifies the operation and target but
   omits requested/effective model, reasoning effort, and inheritance source.

The historical OPE-12 branch at
`ff6a1630ab67406e8bd467cb50a175eaf8b2ae29` contains useful identity, alias,
snapshot, BYOK, billing, and Cursor decisions. It diverges by 142 main-only and
16 feature-only commits from merge base
`477b2bb9e990c73783d5993f9f2a37022683eda3`; its broad history and compaction
implementation conflicts with the current portable-compaction and control-plane
architecture. It must not be replayed wholesale.

## Ownership boundary

OPE-12 owns product model identity, provider/deployment identity, static model
capability metadata, credential-source and billing-owner classification,
availability projection, canonical per-turn model/reasoning semantics, and the
non-secret execution-policy snapshot.

OPE-12 does **not** own:

- Codex account selection, leases, fencing, failover, or portable compaction
  (OPE-21);
- quota windows, reset credits, entitlements, or allocator eligibility truth
  (OPE-24);
- adaptive fleet pressure, health scoring, or admission policy (OPE-32); or
- tool authorization, discovery, defaults, inheritance, and lazy routing
  (OPE-16).

Model `functionCalling` and hosted-tool metadata describes an upstream protocol
capability only. It never grants, discovers, or authorizes a tool. Availability
may consume health or entitlement observations owned by adjacent lanes; it does
not compute those observations.

## Decision

### 1. A selectable product model is not an upstream deployment

The catalog normalizes the existing registry into these logical contracts. The
exact TypeScript representation may be split between config, contracts, and SDK,
but it must preserve these fields and meanings:

```ts
type ModelDefinitionV1 = {
  schemaVersion: 1;
  id: string; // stable canonical product id
  aliases: string[]; // explicit accepted input ids; never fallback
  label: string;
  providerId: string;
  deployment: ModelDeploymentV1;
  executionLimits: ModelExecutionLimitsV1;
  credentialSource: CredentialSourceV1;
  billing: BillingAttributionV1;
  capabilities: ModelCapabilitiesV1;
  pricing?: ModelPricingScheduleV1;
  definitionVersion: string; // deterministic digest of executable fields
};

type ModelDeploymentV1 = {
  upstreamModelId: string; // exact slug/deployment sent to the provider
  wireApi: "responses" | "chat";
};

type ModelExecutionLimitsV1 = {
  contextWindowTokens: number | null;
  effectiveContextWindowTokens: number | null;
  autoCompactTokenLimit: number | null;
  toolOutputTruncationTokens: number | null;
};

type CredentialSourceV1 =
  | { kind: "deployment"; mechanism: "api_key" | "azure_ad_bearer" }
  | { kind: "connected_subscription"; provider: "codex" }
  | { kind: "workspace_connection"; mechanism: "api_key" }; // reserved

type BillingAttributionV1 = {
  upstreamPayer: "deployment" | "workspace" | "connected_subscription";
  metering: "opengeni_credits" | "external";
};
```

Provider organization/adapter identity remains a separate provider definition.
The model definition references it by stable `providerId`; it does not duplicate
base URLs, headers, keys, account ids, or allocator state. A provider may expose
many upstream deployments. A product id resolves to exactly one provider,
credential-source class, billing attribution, and upstream deployment for one
accepted definition version.

Aliases canonicalize to one product id before persistence and policy evaluation.
Alias collisions are boot-time errors. Aliases do not appear as duplicate picker
rows, are never sent upstream, and never trigger provider, credential, billing, or
model fallback. Changing provider, credential-source kind, upstream payer, or
metering owner requires a new canonical product id and an explicit user choice;
an alias cannot move a durable preference across those boundaries.

OPE-35 remains an allowlist over canonical product/provider identity:

- new model-policy PUTs canonicalize every known alias before storing it and
  persist canonical ids for all known models; unknown strings retain the
  existing exact-string behavior so operators may preconfigure a future
  canonical id, but they are not interpreted as aliases;
- the existing GET response continues returning the persisted `allowedModels`
  field, while an additive diagnostic projection may report which legacy values
  resolved and which are unresolved;
- evaluation canonicalizes the candidate and compares its canonical id against
  stored exact strings, so API admission and the worker use the same pure
  verdict. Baseline rows predate aliases and retain their exact canonical or
  unresolved meaning; an old unknown string does not become active merely
  because a later catalog reuses it as an alias; and
- because accepted aliases are stored as canonical ids, later alias removal does
  not change a policy. Any externally inserted/raw alias string is unresolved and
  fails closed (it may block the model, but can never widen access or fall back).

The deployment-wide public `allowedModels` picker list remains canonical-only;
aliases are accepted inputs, not duplicate rows. Tests cover new writes, reads,
baseline exact/unresolved rows, raw alias rows failing closed, collision, unknown
values, and removal preserving canonical policy. No SQL
migration or rewrite of historical policy rows is required.

Existing definitions remain compatible: absent `upstreamModelId` means `id`,
absent aliases means `[]`, existing API-key providers map to deployment
`api_key` credentials/OpenGeni metering, and Codex maps to
connected-subscription credentials/external metering. The built-in Azure path
maps to deployment `api_key` when `azureOpenaiApiKey` is configured and to
deployment `azure_ad_bearer` when the existing `azureOpenaiAdToken` bearer path
is used; the API key continues to win when both are present. No token value is
copied into a definition or turn snapshot. Existing flat `reasoningEffort` and
`hostedWebSearch` fields remain accepted as a compatibility projection while the
normalized capability object becomes canonical.

`definitionVersion` is the lowercase `sha256:` digest of UTF-8
`opengeni:model-definition:v1\n` followed by canonical JSON (object keys sorted
recursively, array order preserved, `undefined` omitted, integers in decimal)
of these normalized fields:

- schema version, canonical product id, provider id, deployment upstream model
  id, and wire API;
- provider adapter kind/API, normalized base URL, and normalized static
  query/header entries as classified below;
- credential-source class/mechanism and billing attribution, but never a
  resolved key/token, key environment-variable value, concrete Codex credential
  id, account label, authorization header, or credential-bearing query value;
- `contextWindowTokens`, `effectiveContextWindowTokens`,
  `autoCompactTokenLimit`, and `toolOutputTruncationTokens` after defaults are
  resolved;
- normalized runnable capability metadata and supported/default reasoning
  efforts; and
- the complete normalized pricing schedule.

The digest input omits `definitionVersion` itself. Registry
`defaultHeaders`/`defaultQuery` retain their existing string-map syntax and
request behavior. Additive `publicDefaultHeaderNames` and
`publicDefaultQueryNames` arrays classify only the named map entries as
non-secret executable configuration. Every unlisted entry is secret by default,
including every entry in legacy registry JSON. Classification is explicit and
fail-closed:

- HTTP header names are validated as ASCII field names and lowercased before
  classification or hashing. Two raw names that collide after normalization are
  a boot error. Query names remain exact and case-sensitive. A public-name entry
  that is duplicated or absent from its corresponding map is a boot error; there
  is no collision precedence.
- Names containing, case-insensitively, a credential-like token delimited by
  `-`, `_`, or `.` (`apikey`, `auth`, `authorization`, `bearer`, `credential`,
  `cookie`, `key`, `password`, `secret`, `session`, `signature`, or `token`)
  cannot be declared public. Built-in key/token fields, registry
  `apiKey`/`apiKeyEnv`, and SDK-managed authorization fields are secret regardless
  of name and cannot be overridden by a default map.
- The canonical digest entry always includes the normalized name and its
  `public` or `secret` classification. A public entry also includes its value; a
  secret entry never does. Secret values are passed to the provider only at
  client construction and are never copied, hashed, logged, projected, or
  persisted by this contract.
- Registry base URLs are parsed with the WHATWG URL algorithm and serialized
  canonically after validation. Userinfo, query, and fragment components are
  rejected at boot; query parameters belong in `defaultQuery`, where their
  sensitivity is explicit. This prevents a credential-bearing URL from entering
  either the definition digest or secret-safe evidence.

This preserves parsing and routing for legacy request maps while conservatively
treating their values as secret. An operator may opt a truly non-secret static
value into definition binding with the additive public-name arrays; changing
that public value changes the digest. Labels, aliases, health/availability
observations, policy results, and secret values are excluded: aliases have
completed their job before persistence, and mutable observations are rechecked
independently. Any change to a participating value changes the digest and makes
an already-present snapshot fail closed. Tests must pin canonical serialization,
header normalization and collision rejection, URL rejection, and public/secret
classification, and prove each participating field changes the digest while
excluded labels, aliases, health, and same-class secret rotations do not.

`allowedModels` and the existing top-level `ClientModel` fields remain additive
compatibility surfaces. New clients consume the normalized fields; old clients
continue to send canonical strings unchanged.

### 2. Capability metadata distinguishes upstream support from runnable support

The catalog must not infer capability from a model name, provider label, pricing
tier, or wire API. Each definition carries explicit evidence-backed metadata:

```ts
type CapabilityStateV1 = {
  upstream: "supported" | "unsupported" | "unknown";
  runnable: boolean; // supported by this OpenGeni adapter and lifecycle
};

type ModelCapabilitiesV1 = {
  reasoning: CapabilityStateV1 & {
    efforts: ReasoningEffort[];
    defaultEffort: ReasoningEffort | null;
    required: boolean;
  };
  functionCalling: CapabilityStateV1;
  structuredOutput: CapabilityStateV1;
  hostedTools: {
    webSearch: CapabilityStateV1;
    xSearch: CapabilityStateV1;
    codeExecution: CapabilityStateV1;
  };
  inputModalities: Array<"text" | "image" | "audio">;
  outputModalities: Array<"text" | "image" | "audio">;
  transports: {
    sse: CapabilityStateV1;
    responsesWebSocket: CapabilityStateV1;
    realtimeAudio: CapabilityStateV1;
  };
  latencyModes: Array<{
    id: "standard" | "priority" | "fast";
    upstream: "supported" | "unsupported" | "unknown";
    runnable: boolean;
    billingMultiplierBps?: number;
  }>;
};
```

`runnable: false` is load-bearing. Provider documentation can prove a feature
exists while OpenGeni lacks request plumbing, lifecycle recovery, or accurate
billing for it. Such a feature may be displayed as unavailable evidence but must
not be selectable or sent upstream.

In particular:

- low reasoning is not “fast”;
- provider priority scheduling is not a separate model slug;
- SSE token streaming is not Responses WebSocket mode; and
- Responses WebSocket mode is not realtime audio/voice.

OPE-12 V1 does not add a latency-mode or realtime request field. Those modes stay
non-runnable until their request, returned-tier attribution, billing, recovery,
and compatibility contracts are independently implemented.

### 3. Definition, credential readiness, health, availability, and policy are separate

A definition says what a product model is. It does not claim that a workspace can
run it. The authenticated workspace projection adds:

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

Workspace availability is returned only by the new
`GET /v1/workspaces/:workspaceId/model-catalog` projection, guarded by
`workspace:read`. The existing public `GET /v1/config/client` remains a static
deployment catalog and may expose
definition/capability metadata, but it must omit workspace credential readiness,
connection state, OPE-35 results, account labels, and workspace availability.
Existing `ClientModel` fields and the public `allowedModels` list remain
unchanged.

Availability is the intersection of:

1. a valid static definition and adapter;
2. an authorized credential source that is ready for this workspace;
3. current provider/deployment health, when known; and
4. OPE-35 workspace model policy.

`selectable` is normative and clients must not infer it from `status` alone. It
is true exactly when the definition is runnable, the workspace credential source
is currently ready, OPE-35 allows the canonical provider/model, and no typed
hard-unavailable observation from the entitlement/health owners applies.
`available` and `degraded` therefore have `selectable: true`; `unavailable` has
`selectable: false`. `unknown` may have `selectable: true` only when credential
readiness and policy are known-good but no current health observation exists;
otherwise it is false. Unknown health is not fabricated as healthy. A deployment
provider whose key is validated at boot may be selectable with health `unknown`;
a connected subscription is selectable only when the existing authenticated
connection path reports it ready. The projection is advisory and is rechecked at
admission and execution. No unavailable definition is silently replaced by
another provider or model. The worker remains the authoritative post-resolution
OPE-35 gate before compaction or the main model call.

OPE-24 remains authoritative for entitlement/quota observations and OPE-32 for
adaptive health/capacity policy. OPE-12 only consumes typed observations if and
when those owners expose them.

### 4. Per-turn switching remains explicit, turn-local, durable, and audited

The existing product semantics are retained and documented:

- session creation stores a durable session model and reasoning preference;
- an explicit `model` or reasoning effort on Send/Steer applies to that accepted
  turn only and does not mutate the session preference;
- an omitted follow-up model uses `sessions.model`;
- an omitted follow-up reasoning effort must use the session reasoning
  preference, not the deployment default;
- a queued prompt may be withdrawn/edited only while queued, after which its
  replacement is admitted normally;
- approval resume, capacity wait, and worker-loss recovery reuse the same turn
  and therefore the same execution policy; and
- a goal continuation is a new turn. It inherits the newest actually-started
  turn’s model/reasoning preference, then resolves the current catalog and
  availability for that new turn.

Child creation is an independent admission. Explicit child model/reasoning values
are validated normally. Omitted child values keep the existing deployment-default
behavior; parent inheritance is not introduced implicitly.

Every newly accepted user/API turn carries a non-secret snapshot in existing
`session_turns.metadata`:

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

The snapshot contains no API key, bearer, credential id, account label, secret
header/query value, or arbitrary URL. OPE-21 may bind and rotate a concrete
credential inside the accepted credential-source class; that binding remains
its fenced interface and is not copied into this snapshot.

At execution, the worker parses the snapshot and resolves the current provider
client. A present malformed snapshot, product/provider mismatch, upstream-model
mismatch, definition-version mismatch, credential-source kind/mechanism
mismatch, or billing mismatch fails closed before any model/compaction call. V1
deliberately fails closed when executable deployment configuration changed; it
does not try to persist arbitrary client construction data. A later
self-contained adapter snapshot requires a separate security review.

Legacy queued turns without a snapshot resolve once before their first model
call and persist a V1 snapshot under the exact attempt fence. Same-turn recovery
then reuses it. New system/goal turns do the same at their first execution
boundary if their admission path could not resolve configuration transactionally.
Malformed present data is never treated as legacy absence.

The legacy/system-turn write is one metadata merge against the exact row whose
workspace id, session id, turn id, active attempt UUID, and execution generation
still match and whose state is executable (`running` or `requires_action`). It
must preserve unrelated dispatch/recovery metadata and affect exactly one row;
zero or multiple matches fail before a provider call. Existing JSONB is
sufficient, so this decision requires no SQL migration.

Foreground command receipt results and `audit_events.metadata` record only the
secret-safe requested/effective model, model source, requested/effective
reasoning effort, reasoning source, provider id, credential-source kind and
mechanism, billing owner, definition version, and turn id. Idempotent replay
returns the same effective values. This is evidence, not a second policy source.

### 5. Credential source and billing owner are explicit but allocator/entitlement logic is unchanged

Provider client construction consumes `credentialSource`; metering consumes
`billing`. Neither is inferred from a model prefix in the normalized path.

- Deployment OpenAI/Azure/registry keys: upstream payer `deployment`, metering
  `opengeni_credits` when managed metering is active.
- Connected Codex subscription: upstream payer `connected_subscription`,
  metering `external`; the current zero-cost audit behavior remains.
- Workspace BYOK: reserved as upstream payer `workspace`, metering `external`,
  but **not implemented in this slice**. It requires an RLS-scoped encrypted
  connection, provider-specific validation, write-only credential handling, and
  a separately reviewed broker-to-worker binding.

OPE-21’s concrete Codex credential id, lease, failover, and capacity wait remain
unchanged. OPE-24’s quota/reset/entitlement result remains unchanged. OPE-32 may
later consume the normalized provider/deployment id but owns all adaptive choice.

The worker must resolve or validate `TurnExecutionPolicyV1` immediately after
claim and before the credit gate, compaction, or main model call. The credit gate
and metering consume the snapshot's explicit billing attribution; the current
pre-resolution Codex-prefix predicate is removed only from this classification
seam. OPE-21 allocation/leases/failover/compaction and OPE-24
quota/entitlement decisions are not modified.

Pricing is keyed by canonical product id and may be a threshold schedule:

```ts
type ModelPricingScheduleV1 = {
  default: ModelPricing;
  inputTokenTiers?: Array<{
    minimumInputTokens: number;
    pricing: ModelPricing;
  }>;
};
```

The applicable tier is selected independently for each provider request from
that request’s input-token count. Tiers are strictly increasing and the default
applies below the first threshold. Provider priority/fast multipliers are not
charged unless the request is runnable and the provider’s actual returned tier
is durably captured; configured intent alone is insufficient.

### 6. Grok 4.5 is an xAI deployment, not a Cursor subscription escape hatch

The only approved raw-inference path for Grok 4.5 in this decision is xAI’s
official API through an explicitly configured deployment provider:

```text
product id:       xai/grok-4.5
compat alias:     grok-4.5
provider id:      xai
upstream model:   grok-4.5
base URL:         https://api.x.ai/v1
wire API:         responses (chat is also provider-supported)
credential:       deployment API key
billing:          deployment upstream / OpenGeni metering
context:          500,000 tokens
```

The definition is not built into every deployment and is not visible merely
because source support exists. It is exposed only when the host explicitly
configures the xAI provider and a real authorized API key resolves at boot. With
no key, it remains hidden/unavailable. Source/config/mock tests prove adapter and
catalog behavior; they do not prove workspace access or production acceptance.

Official xAI evidence supports this capability record:

- reasoning efforts low/medium/high, default high, reasoning required;
- function calling and structured outputs;
- text and image input, text output;
- hosted web search, X search, and code execution;
- SSE streaming;
- Responses WebSocket mode; and
- best-effort priority service tier, billed at 2x only when priority is granted.

For OPE-12 V1, SSE/Responses/function calling and evidence-backed hosted web
search may be runnable through the existing adapter. X search and code execution
remain non-runnable until their hosted-tool request contracts are implemented.
Responses WebSocket remains non-runnable until transport is request-local and
recovery-safe. Priority remains non-runnable until request and actual-tier
billing evidence are durable. Realtime audio is unsupported for this model and
must be false, not inferred from WebSocket support.

Standard xAI pricing below 200,000 input tokens is $2/M input, $0.30/M cached
input, and $6/M output. At or above 200,000 input tokens it is $4/M input,
$0.60/M cached input, and $12/M output. The catalog example and tests must use
this threshold schedule; a flat price is inaccurate.

No authorized xAI credential exists in the reconciled environment or production
secret-key inventory, so no authenticated `/v1/models` or inference call is
permitted now. Production acceptance remains blocked on an already-authorized
product credential and a later minimal staging call with secret-safe logs.

Cursor officially lists Grok 4.5 and exposes public Cloud Agents APIs and agent
SDKs billed to Cursor plans. That is a distinct **agent-runtime integration**:
Cursor owns the agent loop, run model semantics, credential, and billing. Cursor
BYOK means Cursor consumes a customer’s provider key; it does not export Cursor
subscription capacity. OPE-12 therefore does not model a Cursor subscription,
cookie, editor protocol, Cloud Agent key, or SDK session as an xAI/OpenAI raw
model credential. A future Cursor integration must use the official API/SDK and
separate agent-runtime contracts. No Cursor key is currently authorized or
probed.

## Migration plan

Implementation may start only after independent approval of this exact ADR.
The approved slice is additive and ordered:

1. **Normalized config contracts.** Add upstream model id, aliases,
   credential-source, billing, capabilities, deterministic definition version,
   and tiered pricing. Preserve old registry JSON and flat projections.
2. **Client-safe projection.** Add optional normalized static metadata to the
   public `ClientModel`; retain `allowedModels` and all existing fields. Add an
   authenticated workspace catalog for availability and `selectable`. Mark
   upstream support separately from `runnable` and availability.
3. **Canonical admission.** Canonicalize explicit aliases at create,
   Send/Steer, schedule, child admission, and model-policy PUT, then apply
   OPE-35 to canonical product/provider identity. Preserve baseline policy rows
   as exact canonical-or-unresolved strings; unknown model admissions remain 422
   and raw alias policy rows fail closed.
4. **Turn policy and audit.** Correct omitted-reasoning inheritance, write the
   non-secret V1 snapshot, parse/verify it before model calls, and add secret-safe
   receipt/audit evidence. Use existing turn metadata; no SQL migration is
   required.
5. **Provider routing and billing.** Send `upstreamModelId`, key pricing by
   product id, select request pricing tiers, and make metering consume explicit
   billing attribution. Do not alter Codex allocator, entitlement, capacity-wait,
   or compaction internals.
6. **xAI definition and evidence.** Add a documented explicit registry example
   and mocked contract tests for `xai/grok-4.5`. Keep it hidden without a key and
   label live acceptance unverified.
7. **Documentation.** Update `docs/model-providers.md` (canonical),
   `docs/architecture.md`, and `docs/run-lifecycle.md` in the implementation
   change. This record remains point-in-time.

No history projector, provider-owned conversation state, new compaction mode,
quota source, fleet selector, tool policy, broad BYOK broker, Cursor agent
integration, or realtime lifecycle belongs in this slice.

## Compatibility and failure requirements

The implementation must prove:

- legacy registry JSON and request maps continue parsing without annotations and
  valid configurations keep the same product/provider routing; a schema-compatible
  base URL with userinfo, query, or fragment fails startup validation with an
  instruction to move query entries into `defaultQuery`;
- old `allowedModels` and `ClientModel` clients remain compatible;
- aliases canonicalize exactly once and collision/cross-provider ambiguity fails
  at boot;
- OPE-35 stores canonical ids on new writes, preserves baseline exact/unresolved
  rows, rejects raw alias rows at evaluation, and cannot widen access after
  alias removal;
- BYOK is not accidentally enabled by generic provider configuration;
- connected-subscription billing remains external and deployment-key billing
  remains OpenGeni-metered in managed mode;
- an explicit per-turn switch is turn-local, an omitted follow-up uses session
  preference, and goal/child semantics match this ADR;
- approval resume, capacity wait, and worker recovery retain the same V1 policy;
- a new turn re-resolves the current definition;
- every normative definition input and explicitly public request-metadata value
  changes `definitionVersion`, while label, alias, health, and same-class secret
  rotation do not;
- malformed/mismatched present policy fails before any provider call;
- unknown, unavailable, and OPE-35-blocked models never silently fall through to
  the built-in provider;
- xAI priority, WebSocket, X search, code execution, and realtime audio cannot be
  selected when `runnable` is false;
- xAI threshold pricing selects the correct per-request tier at 199,999 and
  200,000 input tokens;
- public config leaks no workspace credential/policy state, and the authenticated
  workspace projection exercises available, unavailable, degraded, and both
  selectable/non-selectable unknown cases; and
- logs, events, receipts, and snapshots contain no credential, secret header,
  token, or credential-bearing URL.

## Verification gates

Before PR readiness:

1. targeted config/contracts/runtime/core/DB/API/worker tests;
2. compatibility, alias, BYOK-negative, connected-subscription, policy,
   billing, fallback, persistence, recovery, and xAI catalog tests;
3. full `bun run typecheck`, `bun test`, formatting/lint, and
   `bun run check:docs-refs`;
4. exact-head CI on the pushed commit;
5. independent Sol/xhigh review of the exact implementation head; and
6. no claim of live xAI acceptance without an already-authorized credential and
   a minimal staging request whose model, returned usage/tier, and secret-safe
   logs are retained as evidence.

OPE-25 alone may release. OPE-12 does not merge, dispatch, or release.

## Rejected alternatives

- **Replay the historical branch.** Rejected: it is stale and conflicts with
  landed lifecycle/compaction ownership.
- **Keep `id` as the upstream slug.** Rejected: product identity would remain
  coupled to provider deployment naming.
- **Infer provider/billing from a prefix.** Rejected: a new externally billed
  credential could be misattributed.
- **Treat aliases as fallback.** Rejected: it can cross provider, credential,
  billing, and policy boundaries silently.
- **Call xAI through Cursor subscription reuse.** Rejected: official evidence
  supports Cursor agent APIs, not export of raw inference capacity.
- **Call priority “fast” or WebSocket “realtime.”** Rejected: they are distinct
  provider capabilities with different lifecycle and billing semantics.
- **Expose Grok without a credential.** Rejected: public documentation proves a
  definition, not workspace availability.
- **Persist arbitrary provider client configuration.** Rejected in V1: headers,
  URLs, and query parameters require a dedicated non-secret adapter-snapshot
  security design.
- **Implement broad workspace BYOK now.** Rejected for this slice: it needs an
  RLS/encryption/broker review and is not required to prove xAI deployment-key
  support.

## Primary sources

Retrieved 2026-07-18 without authentication:

- xAI LLM documentation index: <https://docs.x.ai/llms.txt>
- xAI Grok 4.5: <https://docs.x.ai/developers/models/grok-4.5>
- xAI models: <https://docs.x.ai/developers/models>
- xAI pricing: <https://docs.x.ai/developers/pricing>
- xAI reasoning: <https://docs.x.ai/developers/model-capabilities/text/reasoning>
- xAI function calling: <https://docs.x.ai/developers/tools/function-calling>
- xAI streaming: <https://docs.x.ai/developers/model-capabilities/text/streaming>
- xAI WebSocket mode: <https://docs.x.ai/developers/advanced-api-usage/websocket-mode>
- xAI priority processing: <https://docs.x.ai/developers/advanced-api-usage/priority-processing>
- Cursor model/pricing documentation: <https://cursor.com/docs/models-and-pricing>
- Cursor Grok 4.5 model page: <https://cursor.com/docs/models/grok-4-5>
- Cursor Cloud Agents API overview: <https://cursor.com/docs/cloud-agent/api/endpoints>
- Cursor TypeScript Agent SDK: <https://cursor.com/docs/sdk/typescript>
- Cursor API-key help: <https://cursor.com/help/models-and-usage/api-keys>
- Cursor terms of service (last updated 2026-01-13): <https://cursor.com/terms-of-service>

These sources establish provider/catalog facts only. No authenticated xAI or
Cursor availability, entitlement, pricing response, model-list response, or
inference behavior was probed.
