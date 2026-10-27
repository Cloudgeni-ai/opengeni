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
  `bedrock_geo_profile` whose id does not start with `eu.`, or an endpoint on a
  known global host (`NON_EU_MODEL_HOSTS`, exact host match ignoring a
  trailing dot) is wrong. Every resolver, including built-in models, treats
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

## Recorded region

Every agent-session model call that writes a model-call fact (turn responses,
the aggregate billing fallback, compaction and session titles) records where
the route that served it processes data. Side-feature calls (decision models,
transcription, embeddings, web search and the standalone model-call API) record
it on `usage_events.processing_residency` instead (#6221). The worker resolves
the record from the route that actually served the call (the resolved
`ConfiguredModel.residency`, or `builtinModelResidency` for the built-in
fallback), never from a name, and stores its claim
(`ModelCallProcessingResidencyV1`: `geography`, `deploymentType`, `regions`,
never evidence) on the call's `model_call_facts.processing_residency` and its
durable `agent.model.usage` event as `processingResidency`. The independent
title freezes its accepted route's record in its request; a title whose route
was never resolved records `unknown`, not the turn's record. Facts rebuilt from
usage events keep the event's value. A new call whose route has no readable
record is recorded as `unknown`; null means only that the call was recorded
before calls carried one (migration 1003). A stored `eu` claim reads back as
`eu` only under the same rules as the route record (an EU-capable deployment
type and, for Azure and Bedrock, EU regions only); anything else reads as
`unknown`. Insights calls expose each call's `processingGeography`; it is
undefined in responses from servers older than this release.
