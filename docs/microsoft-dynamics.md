# Microsoft Dynamics connection

One connection type for Microsoft Dynamics environments, signed in with
delegated Microsoft Entra ID. Customer-facing setup lives in
`docs-site/guides/microsoft-dynamics.mdx`.

## Products

| Product | Connection URL | Scope | Tools | Flag |
|---|---|---|---|---|
| Dataverse (Dynamics 365 Sales, Customer Service, …) | `https://<org>.crm[N].dynamics.com/api/mcp` (also `/api/mcp_preview`) | `https://<org host>/user_impersonation` | Dataverse Web API bridge (below) | on when the client is configured |
| Finance and Operations | `https://<env>.operations.dynamics.com/mcp` (also `*.cloudax.dynamics.com`) | `https://<env host>/.default` | Microsoft's ERP MCP server | `OPENGENI_MICROSOFT_DYNAMICS_FINANCE_OPERATIONS_ENABLED` (default off) |
| Business Central | — | — | not supported yet (see below) | — |

`packages/contracts/src/microsoft-dynamics.ts` classifies URLs
(`microsoftDynamicsProductForMcpUrl`), normalises a pasted environment address
to its connection URL (`microsoftDynamicsMcpEndpoint`) and names the scopes.

## Configuration

| Variable | Purpose |
|---|---|
| `OPENGENI_MICROSOFT_DYNAMICS_CLIENT_ID` | Multi-tenant Entra app (pre-registered; Microsoft has no dynamic client registration here). |
| `OPENGENI_MICROSOFT_DYNAMICS_CLIENT_SECRET` | Its client secret. Set both or neither. |
| `OPENGENI_MICROSOFT_DYNAMICS_FINANCE_OPERATIONS_ENABLED` | Accept Finance and Operations URLs. |

The Entra app needs:

- redirect URI `<public API origin>/v1/integrations/oauth/callback` (Web platform);
- delegated API permissions **Dynamics CRM → user_impersonation** and, for
  Finance and Operations, **Dynamics ERP** permissions (`mcp.tools`), plus
  Microsoft Graph `openid`, `profile`, `offline_access`;
- "Accounts in any organizational directory" (multi-tenant).

It is separate from the Microsoft 365 and Teams apps so customers can consent
to Dynamics on its own.

## Sign-in

`MICROSOFT_DYNAMICS_PROFILE` in `apps/api/src/integrations/oauth-profiles.ts`
matches by URL rather than issuer, because the authorization server is fixed
while the resource host is per customer:

- Discovery uses the fixed Entra `organizations` metadata
  (`fixedAuthorizationServer`) and the profile's scopes. Entra's metadata
  omits `code_challenge_methods_supported`, but Entra documents PKCE S256, so
  the profile asserts it.
- The issuer is Entra's `{tenantid}` template; the ID token's `iss` is checked
  against its own `tid` after signature verification.
- No `resource` parameter is sent (Entra v2 rejects it next to scopes).
  Refreshes resend the stored scope (`refresh_scope`), because Entra issues an
  access token for one resource at a time.
- Entra consent errors (`AADSTS65001`, `AADSTS90094`, `consent_required`, …)
  use the shared Microsoft admin-consent handling: the attempt fails with
  `admin_consent_required` and an approval link, and the admin's return lands
  on the shared approval result page.

## Dataverse Web API bridge

`packages/runtime/src/dataverse-web-api-mcp.ts` is a local MCP bridge (like
the Gmail and Slack REST adapters). It replaces Microsoft's hosted Dataverse
MCP server for Dataverse connections and serves generic tools over
`https://<org host>/api/data/v9.2/` with the connection's grant:
`dataverse_list_tables`, `dataverse_describe_table`, `dataverse_query` (OData
GET, including `$apply` aggregates and paging), `dataverse_fetchxml`, and
`dataverse_create_record` / `dataverse_update_record` /
`dataverse_delete_record`. The three change tools recommend Ask first through
`opengeni/recommendedPermission` tool metadata.

Why the Web API rather than the hosted MCP server (checked against a real
Dynamics 365 Sales environment):

- the hosted server accepts non-Microsoft clients only after an admin turns it
  on and allow-lists the app, and bills calls in Copilot Credits; the Web API
  needs only Entra consent and counts toward normal API request limits;
- its `read_query` returns at most 20 rows and its SQL has no date grouping or
  expression aggregates; OData `$apply` and FetchXML cover both and page up to
  5,000 rows.

The token resolver lets a Dataverse connection's grant reach only the Web API
root on the same host (`isDataverseWebApiDestination`). Microsoft's error
message reaches the agent; a write whose outcome is unknown (network failure,
5xx) is reported as uncertain and never retried.

## Business Central (follow-up)

Business Central's MCP server (`https://mcp.businesscentral.dynamics.com`) and
API (`https://api.businesscentral.dynamics.com/v2.0/<tenant>/<environment>/`)
both need the tenant and environment name per connection (MCP through
`TenantId` / `EnvironmentName` headers). The scope is
`https://<mcp|api>.businesscentral.dynamics.com/Financials.ReadWrite.All`. Add
it with a bridge or headers that take the tenant from the token's `tid` and the
environment from the connection URL.
