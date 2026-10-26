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
  An `eu` claim on a Bedrock `bedrock_geo_profile` whose upstream id does not
  start with `eu.` counts as unknown. Names only ever reject a claim, never
  grant one.
- Operators declare residency only on deployment registry providers
  (`kind` `api-key` or `anonymous`), in `OPENGENI_MODEL_PROVIDERS_JSON` or the
  database catalog's `registryProviders`: `residency` on the provider applies to
  its models, and `residency` on a model overrides it. Operator evidence is
  `operator_declaration` or `provider_documentation`. Residency is part of the
  transport: in database catalog mode the host `OPENGENI_MODEL_PROVIDERS_JSON`
  entry that owns the endpoint must declare exactly the same residency as the
  database document, for the provider and each model, or the catalog is
  refused.
- Each built-in OpenAI or Azure model is its own deployment, so
  `OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON` maps model ids to declarations
  (`{"gpt-eu": {...}}`). An undeclared built-in model uses the rule below.
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
