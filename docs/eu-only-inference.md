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
  and a deployment type that cannot route globally (`azure_global`,
  `bedrock_global_profile` and `unknown` are rejected).
- Operators declare residency only on deployment registry providers
  (`kind` `api-key` or `anonymous`), in `OPENGENI_MODEL_PROVIDERS_JSON` or the
  database catalog's `registryProviders`: `residency` on the provider applies to
  its models, and `residency` on a model overrides it. The built-in OpenAI or
  Azure provider uses `OPENGENI_BUILTIN_MODEL_RESIDENCY_JSON`.
- Every other provider kind uses a code-owned rule with `built_in_rule`
  evidence and cannot declare its own: Codex, SuperGrok and Claude
  subscriptions, the Anthropic API, OpenAI API keys (`api.openai.com`), Vercel
  AI Gateway and OpenRouter are not EU; Opper and customer Azure OpenAI
  connections are unknown. The built-in Azure provider without a declaration is
  unknown, because GlobalStandard deployments may process in any Azure region.
- A declared record is part of the model's definition version, so changing it
  fails accepted turns instead of silently moving them. Built-in rules and
  undeclared routes do not change existing digests.
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
