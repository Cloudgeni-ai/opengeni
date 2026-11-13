---
"@opengeni/runtime": minor
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/db": patch
"@opengeni/core": patch
---

Dynamics 365 Finance and Operations now works in every Microsoft Dynamics connection without a flag. Its tools run on the environment's OData data entities with the person's own sign-in, so customers no longer add Opengeni to **Allowed MCP clients** and calls don't use Copilot Credits. Agents list and describe data entities, query one company or all of them (with counts), and create, update and delete records; changes ask first. `OPENGENI_MICROSOFT_DYNAMICS_FINANCE_OPERATIONS_ENABLED` is removed and ignored if still set.

Existing Finance and Operations connections switch from the ERP MCP server's tools to the `fno_*` tools, so tool permissions saved under the old tool names no longer apply; set them again on the new tools. Tenants that consented before the app requested **Access Dynamics AX data** (`Odata.FullAccess`) need an administrator to consent again.
