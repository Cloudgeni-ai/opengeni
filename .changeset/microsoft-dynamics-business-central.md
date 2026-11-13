---
"@opengeni/contracts": minor
"@opengeni/runtime": minor
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
---

The Microsoft Dynamics connection now supports Dynamics 365 Business Central. Paste the Business Central web client address (`https://businesscentral.dynamics.com/<tenant>/<environment>?company=…`) and sign in; one connection covers every company in the environment. Agents list companies and entities, query with OData, create, update and delete records and run actions such as posting, through the Business Central API (v2.0) as the signed-in user. Changes ask first by default.
