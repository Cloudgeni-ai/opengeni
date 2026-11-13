---
"@opengeni/sdk": minor
---

Organization Azure OpenAI deployments, OpenAI models and OpenAI-compatible endpoint models can now be priced, so their usage shows a cost estimate and counts toward spend limits instead of being recorded without a cost. A new Azure deployment takes the price of the base model Azure reports serving; administrators can choose a base model or enter their own rate per 1M tokens with the price button on each model's row, or with `setOrganizationProviderCustomModelListPrice` and `setOrganizationCompatibleEndpointModelListPrice`. Each model reports its `listPrice` and whether its usage is priced (`listPriceKnown`); a model without a price is shown as unpriced, never as free.
