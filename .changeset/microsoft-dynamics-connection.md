---
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/runtime": minor
---

Add a Microsoft Dynamics connection. Dynamics 365 Sales and other Dataverse environments sign in with Microsoft Entra ID through a deployment-registered app (`OPENGENI_MICROSOFT_DYNAMICS_CLIENT_ID` / `_CLIENT_SECRET`) and get generic Dataverse tools over the environment's Web API: list and describe tables, OData and FetchXML queries, and create, update and delete records (changes ask first by default). Finance and Operations uses Microsoft's ERP MCP server behind `OPENGENI_MICROSOFT_DYNAMICS_FINANCE_OPERATIONS_ENABLED`.
