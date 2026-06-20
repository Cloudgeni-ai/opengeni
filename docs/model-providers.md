# Multi-provider model support

OpenGeni lets the **host/deployer** expose models from one or more LLM providers,
and lets **any client** (SDK + React composer) discover the exposed models and pick
between them at send time. This document is the authoritative design + integration
contract for that capability. The first non-OpenAI provider shipped against it is
**Fireworks AI**, serving **GLM 5.2** (`accounts/fireworks/models/glm-5p2`).

## Architecture at a glance

- A **built-in provider** (OpenAI **or** Azure, selected by `OPENGENI_OPENAI_PROVIDER`)
  is configured by the existing flat env vars and is always present. It serves its
  models through the **OpenAI Responses API**.
- **Extra providers** are declared by the host via a JSON **provider registry**
  (`OPENGENI_MODEL_PROVIDERS_JSON`). Each entry carries its own base URL, API key,
  wire API (`responses` | `chat`), and the list of models it exposes.
- The set of models a client may use is the **union** of the built-in provider's
  allowed models and every registry provider's models. The host curates exposure by
  editing `OPENGENI_OPENAI_ALLOWED_MODELS` and the registry.
- At run time the chosen model string is **resolved to its provider**, a per-provider
  `OpenAI` client is built, and an `@openai/agents` **`Model` instance** bound to that
  client (`OpenAIResponsesModel` for `responses`, `OpenAIChatCompletionsModel` for
  `chat`) is passed to the agent. This routes per-model to the right provider
  **without** touching the global default client or forking the SDK. Concurrent
  multi-provider works out of the box.

### Why Fireworks uses the `chat` wire API (not Responses)

Live probing of Fireworks (2026-06) showed its beta `/v1/responses` echoes the user
input back as an output `message` item, emits reasoning inline as `output_text`, and
accepts `web_search`/`reasoning.encrypted_content` params **without executing them** —
all of which would corrupt the agent's conversation history or hand it a dead tool.
Fireworks' `/v1/chat/completions` is clean and standard; GLM 5.2 there cleanly splits
`reasoning_content` from `content` and supports `reasoning_effort` + streaming + tool
calls. So Fireworks is wired as `api: "chat"`. OpenAI/Azure remain `responses`.

## Config layer — `packages/config/src/index.ts`

### New Settings field
```ts
modelProvidersJson: z.string().default("[]"),   // env: OPENGENI_MODEL_PROVIDERS_JSON
```
Parse it in `getSettings()` alongside the other `optional(...)` reads:
`modelProvidersJson: optional("OPENGENI_MODEL_PROVIDERS_JSON")`.

### New schemas + types (exported)
```ts
export const ModelProviderApi = z.enum(["responses", "chat"]);
export type ModelProviderApi = z.infer<typeof ModelProviderApi>;

const RegistryModelSchema = z.object({
  id: z.string().min(1),                 // model id sent to the provider, e.g. "accounts/fireworks/models/glm-5p2"
  label: z.string().min(1).optional(),   // display name; defaults to id
  contextWindowTokens: z.number().int().positive().optional(),
  reasoningEffort: z.boolean().optional(),  // model accepts a reasoning-effort control
  hostedWebSearch: z.boolean().optional(),  // provider executes the hosted web_search tool for this model
  pricing: ModelPricingSchema.optional(),
});

const RegistryProviderSchema = z.object({
  id: z.string().min(1).regex(registryId),  // stable provider id, e.g. "fireworks" (same [A-Za-z0-9_-]+ shape as MCP server ids)
  label: z.string().min(1).optional(),
  api: ModelProviderApi.default("chat"),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),         // inline key (pragmatic) ...
  apiKeyEnv: z.string().optional(),      // ... OR name of the env var holding the key (preferred)
  defaultQuery: z.record(z.string()).optional(),
  defaultHeaders: z.record(z.string()).optional(),
  models: z.array(RegistryModelSchema).min(1),
});
export type RegistryProvider = z.infer<typeof RegistryProviderSchema>;

// Runtime-resolved provider (built-in or registry), client-construction-ready.
export interface ResolvedModelProvider {
  id: string;                  // "openai" | "azure" | registry id
  label: string;
  api: ModelProviderApi;
  builtin: boolean;
  baseUrl?: string;
  apiKey?: string;
  defaultQuery?: Record<string, string>;
  defaultHeaders?: Record<string, string>;
  compactionMode: ContextCompactionMode;   // "server" only for built-in OpenAI; "client" otherwise
}

// A single exposed model + the provider that serves it.
export interface ConfiguredModel {
  id: string;
  label: string;
  providerId: string;
  providerLabel: string;
  api: ModelProviderApi;
  contextWindowTokens?: number;
  reasoningEffort: boolean;
  hostedWebSearch: boolean;
}
```

### New / changed functions
- `parseModelProvidersJson(json: string): RegistryProvider[]` — parse + validate; `[]` on empty.
- `resolveProviderApiKey(provider, source = process.env): string | undefined` — `apiKey ?? source[apiKeyEnv]`.
- `configuredProviders(settings): ResolvedModelProvider[]` — built-in provider first
  (id `openai`/`azure`, `api: "responses"`, `compactionMode: resolveContextCompactionMode(settings)`,
  client inputs from the existing openai/azure fields), then registry providers
  (`compactionMode: "client"`). Registry id may not collide with the built-in id (throw in `validateSettings`).
- `configuredModels(settings): ConfiguredModel[]` — built-in models first
  (`configuredAllowedModels`-from-openai mapped: `api: "responses"`,
  `hostedWebSearch: settings.webSearchEnabled`, `contextWindowTokens: settings.contextWindowTokens`,
  `reasoningEffort: true`), then each registry provider's models (defaults: label→id,
  `hostedWebSearch` defaults `false`, `reasoningEffort` defaults `false`). De-dup by `id`, first wins, default model first.
- `configuredAllowedModels(settings)` — **reimplement** as `configuredModels(settings).map(m => m.id)`
  (keeps existing behaviour: `settings.openaiModel` first, then the openai allow-list, now plus registry ids).
- `resolveModelProvider(settings, modelId): { provider: ResolvedModelProvider; model: ConfiguredModel } | undefined`.
- `configuredModelPricing(settings)` — merge order: `defaultModelPricing` →
  registry model `pricing` entries (keyed by model id) → `parseModelPricingJson(settings.modelPricingJson)` (explicit JSON wins).
- `defaultModelPricing` — add a built-in entry so managed billing works out of the box:
  ```ts
  "accounts/fireworks/models/glm-5p2": {
    inputMicrosPerMillionTokens: 1_400_000,
    cachedInputMicrosPerMillionTokens: 260_000,
    outputMicrosPerMillionTokens: 4_400_000,
    marginBps: 2_500,
  },
  ```
- `validateSettings` — parse the registry (surface JSON/zod errors at boot), reject a
  registry id equal to the built-in id, and require a resolvable API key for every
  registry provider. Existing managed-billing pricing check already covers registry
  models because they flow through `configuredAllowedModels`.

## Contracts — `packages/contracts/src/index.ts`

Extend `ClientConfig` (keep `allowedModels: string[]` for back-compat):
```ts
export const ClientModel = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),        // provider id
  providerLabel: z.string(),
  api: z.enum(["responses", "chat"]),
  contextWindowTokens: z.number().int().positive().optional(),
});
export type ClientModel = z.infer<typeof ClientModel>;
// in ClientConfig:
models: z.array(ClientModel).default([]),
```

### Sandbox-path model routing (critical)

Binding a provider's `Model` **instance** to `agent.model` only routes correctly
on the in-process run (`sandboxBackend: "none"`). On the **SandboxAgent / Modal**
path the instance is dropped and the model **name** is re-resolved through the
run's model provider — which, by default, is the built-in (OpenAI/Azure) client,
so a registry model 404s ("The API deployment for this resource does not exist").
The fix: `configureOpenAI` installs a **`MultiProviderModelProvider`** as the
process default model provider (`setDefaultModelProvider`). It routes any model
name back to its provider via `resolveTurnModel` (falling back to the SDK default
provider for unconfigured names). The worker therefore passes the model as a
**string** (`agent.model = runSettings.openaiModel`), not an instance, so every
path resolves through the router. Gating (compaction/web-search/encrypted
reasoning/context window) still comes from `resolveTurnModel` in the worker.

## Runtime — `packages/runtime/src/index.ts`

- Import `OpenAIResponsesModel`, `OpenAIChatCompletionsModel` from the agents SDK
  (use `@openai/agents-openai`; fall back to `@openai/agents` if re-exported — the
  typecheck decides). Add `@openai/agents-openai` to `packages/runtime/package.json`
  deps if the import needs it.
- `buildProviderClient(provider: ResolvedModelProvider, settings: Settings): OpenAI`
  — generalises `buildOpenAIClientFromSettings`. Built-in azure/openai keep their exact
  current construction; registry providers →
  `new OpenAI({ apiKey: resolveProviderApiKey(provider), baseURL: provider.baseUrl, maxRetries: settings.openaiMaxRetries, defaultQuery, defaultHeaders })`.
  Cache one client per `provider.id` (module-level `Map`).
- `buildModelInstance(provider, client, modelId): Model` —
  `provider.api === "chat" ? new OpenAIChatCompletionsModel(client, modelId) : new OpenAIResponsesModel(client, modelId)`.
- `resolveTurnModel(settings, modelId): { provider, client, model: Model, configured: ConfiguredModel } | null`
  — looks up `resolveModelProvider`, builds client + Model instance. Returns `null`
  (caller falls back to the legacy global-client path) when the model isn't in the registry.
- Extend `BuildAgentOptions` with optional gating overrides (all default to today's behaviour when omitted):
  ```ts
  compactionMode?: ContextCompactionMode;   // default resolveContextCompactionMode(settings)
  hostedWebSearch?: boolean;                 // default settings.webSearchEnabled
  encryptedReasoning?: boolean;              // default settings.openaiReasoningEncryptedContent
  contextWindowTokens?: number;              // default settings.contextWindowTokens
  ```
  In `buildOpenGeniAgent`: `hostedTools` gated on `options.hostedWebSearch ?? settings.webSearchEnabled`;
  encrypted-reasoning `providerData.include` gated on `options.encryptedReasoning ?? settings.openaiReasoningEncryptedContent`;
  `store: false` gated on the resolved compaction mode being `server`.
- `buildAgentCapabilities` takes the resolved `compactionMode` (+ effective context
  window) instead of calling `resolveContextCompactionMode(settings)` internally.
- `summarizeForCompaction` becomes provider-aware: accept `{ client, api }`; for
  `api === "chat"` call `client.chat.completions.create({...})` and read
  `choices[0].message.content`; for `responses` keep the current
  `client.responses.create` path. `extractResponseOutputText` must only read
  `role === "assistant"` message items (guards against any input-echo).

## Worker — `apps/worker/src/activities/agent-turn.ts`

Resolve the turn's model once, then pass the Model instance + gating into `buildAgent`:
```ts
const resolved = runtime.resolveTurnModel(settings, turn.model);
const agent = runtime.buildAgent(settings, turnResources, {
  ...(resolved
    ? {
        model: resolved.model,
        compactionMode: resolved.provider.compactionMode,
        hostedWebSearch: resolved.configured.hostedWebSearch,
        encryptedReasoning: resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
        contextWindowTokens: resolved.configured.contextWindowTokens ?? settings.contextWindowTokens,
      }
    : {}),                       // legacy path: settings.openaiModel + global client
  ...existingOptions,
});
```
Thread `resolved.client` + `resolved.provider.api` into the client-side compaction
summarizer call. Keep the `runSettings.openaiModel = turn.model` plumbing for the
no-resolution fallback. Cost accounting (`configuredModelPricing(settings)[input.model]`)
already covers registry models.

## SDK — `packages/sdk/src/client.ts` + `types.ts`

- Add `getClientConfig(): Promise<ClientConfig>` → `GET /v1/config/client`.
- Re-export `ClientConfig` and `ClientModel` types from `packages/sdk/src/index.ts`.
- No change to how `model` is sent (already `model?: string` on `SendMessageInput` etc.).

## React — `packages/react`

- `useAvailableModels(client)` hook → fetches `getClientConfig()`, returns
  `{ models: ClientModel[], defaultModel, loading, error }`.
- `<ModelPicker>` component (`packages/react/src/components/model-picker.tsx`) — a
  dropdown grouped by `providerLabel`, showing each model's `label`; controlled via
  `value` / `onChange`.
- `ChatComposer` gains optional `models`, `selectedModel`, `onSelectModel` props; when
  `models` is provided it renders `<ModelPicker>` in `controlsStart` and threads the
  selection into `sendExtras` so `composeSendInput` carries `model`.
- `demo/mock.ts` returns a multi-provider `getClientConfig()` fixture (OpenAI + Fireworks)
  so the demo exercises the picker.

## Web app — `apps/web`

Wire `useAvailableModels` + the composer's new props into the real app composer so the
deployed UI shows the host-exposed model list and remembers the selection per session.

## Host configuration example (Fireworks + GLM 5.2)

```bash
# Built-in provider stays OpenAI (or Azure) as today.
OPENGENI_OPENAI_PROVIDER=openai
OPENGENI_OPENAI_MODEL=gpt-5.5
OPENGENI_OPENAI_ALLOWED_MODELS=gpt-5.5,gpt-5.4

# Add Fireworks as an extra provider exposing GLM 5.2.
OPENGENI_FIREWORKS_API_KEY=fw_...
OPENGENI_MODEL_PROVIDERS_JSON='[
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
]'
```
Clients then see `gpt-5.5`, `gpt-5.4`, and `GLM 5.2` in the picker and can select any of them.

## Verification

1. `bun run typecheck` (whole workspace) clean.
2. `bun test` (unit) green, including new config/contracts/runtime/api tests.
3. Live Fireworks e2e (`test/live/`, gated on `OPENGENI_FIREWORKS_API_KEY`): resolve
   `accounts/fireworks/models/glm-5p2`, build the chat Model, run a one-turn agent with a
   tool, assert a clean assistant response + correct provider routing.
