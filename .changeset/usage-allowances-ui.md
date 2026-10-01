---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Usage allowance UI. `@opengeni/react/usage` adds `useUsage`, `UsageMeter`,
`UsageLimitNotice` (the calm near/at-limit composer line) and
`UsageMemberList` (an admin roster with a share-of-budget slider that shows
oversubscription as allowed). The conversation renders an allowance refusal as
a structured "usage limit reached" row that hosts reword with
`allowanceExhaustedLabels` or replace with `renderAllowanceExhausted`, and a
queued prompt refused before it starts stays above that row.
`@opengeni/sdk/usage-allowances` exposes allowance reads and administration as
free functions over `requestJson` for browser code without the root client.
