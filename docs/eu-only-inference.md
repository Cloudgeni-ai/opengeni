# EU-only inference

EU-only inference keeps every model call for an organization's workspaces on
routes that process data in the EU. It is enforced on the server and fails
closed. This page is the canonical home for the residency record, the setting
and its enforcement points; other docs link here.

"EU" follows GDPR: EEA processing counts the same as EU processing, so a
provider's EU data zone (Azure Data Zone EU, Bedrock `eu.` inference profiles)
qualifies even when it can include Norway or Switzerland.

## Residency record

Every model route carries a `ModelResidencyV1` record
(`packages/contracts/src/model-residency.ts`), resolved onto
`ConfiguredModel.residency` in `packages/config`:

| Field | Meaning |
| --- | --- |
| `geography` | `eu`, `us`, `global`, `other` or `unknown` |
| `deploymentType` | `azure_regional`, `azure_data_zone`, `azure_global`, `bedrock_regional`, `bedrock_geo_profile`, `bedrock_global_profile`, `gateway`, `subscription`, `provider_default`, `self_hosted` or `unknown` |
| `regions` | Provider regions where the endpoint or processing lives, when known |
| `evidence` | `source` (`operator_declaration`, `provider_documentation`, `provider_api`, `built_in_rule`, `admin_declaration`, `none`), a `reference` to check, and `verifiedAt` |

Rules:

- EU status comes only from this record (`isEuResidency`), never from a model
  id, label or provider name. A route without a record is `unknown`, and
  unknown is never EU.
- An `eu` claim needs an evidence source other than `none` with a reference,
  and one of the deployment types that can be EU: `azure_regional`,
  `azure_data_zone`, `bedrock_regional`, `bedrock_geo_profile`,
  `provider_default` or `self_hosted`. Gateways, subscriptions, global routing,
  `unknown` and any type added later can never be EU.
- An Azure or Bedrock `eu` claim must list its regions, and every region must
  be on the code-owned EEA (plus Switzerland) list for that cloud
  (`EU_AZURE_REGIONS`, `EU_AWS_REGIONS`). The United Kingdom is not in the EEA.
- An `eu` claim must also fit its route (`modelResidencyRouteProblems`): a
  Bedrock upstream id with a non-EU inference profile prefix (`us.`,
  `us-gov.`, `apac.`, `jp.`, `au.`, `ca.`, `global.`, any case), a
  `bedrock_geo_profile` whose id does not start with `eu.`, an endpoint on a
  known global host (`NON_EU_MODEL_HOSTS`, exact host match ignoring a
  trailing dot), or a deployment-path endpoint (`.../deployments/{name}`,
  Azure's form) whose deployment is not the model's upstream id is wrong. Such
  an endpoint runs its deployment whatever model the request names, so only
  that one model can be EU on it; this includes the built-in Azure provider
  configured with `OPENGENI_AZURE_OPENAI_ENDPOINT` and
  `OPENGENI_AZURE_OPENAI_DEPLOYMENT` and no base URL. Every resolver, including built-in models, treats
  such a claim as unknown. `OPENGENI_MODEL_PROVIDERS_JSON`,
  `OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON` and the catalog upsert refuse it; a
  stored database document is never refused for it, so a later release that
  adds a host or prefix cannot take the catalog down. Names only ever reject a
  claim, never grant one.
- Operators declare residency only on deployment registry providers
  (`kind` `api-key` or `anonymous`), in `OPENGENI_MODEL_PROVIDERS_JSON` or the
  database catalog's `registryProviders`: `residency` on the provider applies to
  its models, and `residency` on a model overrides it. Operator evidence is
  `operator_declaration` or `provider_documentation`.
- Residency is part of the transport. In database catalog mode the host
  `OPENGENI_MODEL_PROVIDERS_JSON` entry that owns an `api-key` provider's
  endpoint supplies its residency. The database document must make the same
  claim (geography, deployment type and regions) for each model; evidence and
  dates come from the host, so re-verifying never needs a database change. A
  one-sided or different claim makes that provider's routes unknown (and logs
  a warning once) without failing the rest of the catalog; the catalog upsert
  refuses it. For `anonymous`
  providers the database document owns the endpoint and its residency.
- Each built-in OpenAI or Azure model is its own deployment, so
  `OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON` maps model ids to declarations
  (`{"gpt-eu": {...}}`). An undeclared built-in model uses the rule below, and
  a key that is not a configured built-in model logs a warning at startup (in
  code catalog mode, where the environment lists the built-in models).
- Every other provider kind uses a code-owned rule with `built_in_rule`
  evidence and cannot declare its own: Codex, SuperGrok and Claude
  subscriptions, the Anthropic API, OpenAI API keys (`api.openai.com`), Vercel
  AI Gateway and OpenRouter are not EU; Opper and customer Azure OpenAI
  connections are unknown. The built-in Azure provider without a declaration is
  unknown, because GlobalStandard deployments may process in any Azure region.
- A declared record's geography, deployment type and regions (sorted and
  deduplicated) are part of the model's definition version, so moving a route
  fails accepted turns instead of silently moving them. Re-verifying evidence
  does not change the digest. Built-in rules and undeclared routes do not
  change existing digests. Enforcement checks `isEuResidency` on the live
  record at every call and never relies on a matching definition version.
- Clients receive `ClientModel.residency` without the evidence reference, which
  may name internal resources.

Declaration example (a registry provider in the deployment catalog):

```json
{
  "id": "azure-eu",
  "api": "responses",
  "wireProfile": "azure-openai",
  "baseUrl": "https://example-neu.openai.azure.com/openai/v1",
  "residency": {
    "geography": "eu",
    "deploymentType": "azure_data_zone",
    "regions": ["swedencentral"],
    "evidence": {
      "source": "operator_declaration",
      "reference": "Deployment gpt-eu on example-neu, sku DataZoneStandard",
      "verifiedAt": "2026-10-26"
    }
  },
  "models": [{ "id": "azure-eu/gpt-eu", "upstreamModelId": "gpt-eu" }]
}
```

## Enforcement

The setting is read per workspace with `isWorkspaceEuOnly` (today it follows
the organization). When a workspace is EU-only, every model call must run on an
EU route, and nothing falls back to a route that is not EU.

- **Settings.** `settingsWithInferenceResidency` (applied first by
  `settingsWithModelProviderCredentials`, the overlay every run, title, model
  call and compaction uses) sets `requiredModelGeography: "eu"` on the run's
  settings. It is per-run only and never read from the environment. A failed
  read throws.
- **Resolution.** `resolveTurnModel` refuses a route whose live residency
  record is not EU, and refuses an unlisted model instead of using the legacy
  built-in client. The built-in fallback binding in `MultiProviderModelProvider`
  checks the built-in model's record the same way.
- **Transport.** Every provider adapter (OpenAI and Azure Responses and Chat,
  Anthropic Messages, Codex, SuperGrok, gateways) sends through
  `instrumentedModelFetch`, which checks each request before it is sent:
  - A client built from EU settings carries the requirement, so it refuses any
    request whose provider and request-body model are not an EU route
    (`euModelRoutes`), wherever it is used. When the URL calls a deployment by
    path (`/openai/deployments/{name}/`), that deployment must be an EU route
    too, because the provider runs it rather than the body's model. Clients
    for EU and other settings are never shared through the client cache.
  - The body's model is read from the object an SDK request body encodes, so
    a request is never buffered for the check; only other stream bodies are
    read from a copy.
  - The run's context (`withInferenceResidency`) adds the same check for
    clients built before the setting was known. A worker turn starts with an
    unresolved context that refuses every request until the claim binds it,
    and an EU context never widens again. A nested context applies on top of
    the contexts around it: their requirements combine, and it refuses while
    any of them is unresolved.
  - Other provider requests (images, audio, files) are refused under EU unless
    they are `GET` or `HEAD` reads such as model lists, with or without a
    body. Side features check their own routes before calling.
  - A refusal is final. The OpenAI SDK does not retry it and surfaces the
    typed error itself, not a connection error.
- **Worker.** Each attempt reads the setting again right after its claim and
  before any model call (`settingsWithTurnInferenceResidency`), so a setting
  turned on after the claim still applies. The narrowed settings replace the
  claim's for the rest of the attempt: resolution, run settings and every
  client built from them carry the requirement. A turn whose route is not EU
  fails once with `region_restricted`, not retryable, however an SDK wrapped
  the refusal. A turn already running keeps its route until its next attempt;
  the transport check still applies to every request it sends.
- **API.** The model-call API returns `422` with code `region_restricted`.

A refusal is `InferenceRegionRestrictedError` (code `region_restricted`), whose
message says the model is not supported in EU.
