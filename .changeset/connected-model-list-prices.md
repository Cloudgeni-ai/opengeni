---
"@opengeni/sdk": minor
---

Azure OpenAI deployments, OpenAI models and OpenAI-compatible endpoint models connected by an organization or by one workspace can now be priced, so their usage shows a cost estimate and counts toward spend limits instead of being recorded without a cost. A new Azure deployment takes the price of the base model Azure reports serving; administrators can choose a base model or enter their own rate per 1M tokens with the price button on each model's row, or with `setOrganizationProviderCustomModelListPrice`, `setOrganizationCompatibleEndpointModelListPrice` and `setWorkspaceModelKeyListPrice` (`listModelPriceBasisModels` lists the base models for a workspace). Each model reports its `listPrice` and whether its usage is priced (`listPriceKnown`); a model without a price is shown as unpriced, never as free.
