---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/config": patch
---

Show EU-only inference in the app. Organization settings > Security & data has
an EU-only inference switch: members see it, owners and admins turn it on, and
turning it off is offered only when the API answers `canTurnOff`, after a
confirmation; without a recent sign-in it offers "Sign in again" first. In an
EU-only workspace, models and features the server switched
off (reason `region_restricted`) show "Not supported in EU" and can't be chosen
or turned on. New SDK methods `getOrganizationInferenceResidency` and
`updateOrganizationInferenceResidency`, `ClientConfig.inferenceFeatures` and
`ClientModel.availability` types, and `@opengeni/react` helpers
`isRegionRestricted`, `regionRestrictedText` and `inferenceFeatureRestriction`.
The curated Opper model is labelled "Claude Opus 5.5": EU status comes from
residency records, never a name.
