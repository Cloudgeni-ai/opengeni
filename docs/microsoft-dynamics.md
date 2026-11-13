# Microsoft Dynamics connection

One connection type for Microsoft Dynamics environments, signed in with
delegated Microsoft Entra ID. Customer-facing setup lives in
`docs-site/guides/microsoft-dynamics.mdx`.

## Products

| Product | Connection URL | Scope | Tools | Flag |
|---|---|---|---|---|
| Dataverse (Dynamics 365 Sales, Customer Service, …) | `https://<org>.crm[N].dynamics.com/api/mcp` (also `/api/mcp_preview`) | `https://<org host>/user_impersonation` | Dataverse Web API bridge (below) | on when the client is configured |
| Finance and Operations | `https://<env>.operations.dynamics.com/mcp` (also `*.cloudax.dynamics.com`) | `https://<env host>/.default` | Microsoft's ERP MCP server | `OPENGENI_MICROSOFT_DYNAMICS_FINANCE_OPERATIONS_ENABLED` (default off) |
| Business Central | `https://api.businesscentral.dynamics.com/v2.0/[<tenant>/]<environment>/api/v2.0` | `https://api.businesscentral.dynamics.com/Financials.ReadWrite.All` | Business Central API bridge (below) | on when the client is configured |

`packages/contracts/src/microsoft-dynamics.ts` classifies URLs
(`microsoftDynamicsProductForMcpUrl`), normalises a pasted environment address
to its connection URL (`microsoftDynamicsMcpEndpoint`) and names the scopes.
A Business Central address is the web client
(`https://businesscentral.dynamics.com/<tenant>/<environment>?company=…`; no
environment means `Production`, a `?tenant=` query also names the tenant) or
any API URL of the environment. The company is not part of the connection:
one connection covers every company, and tools take the company name or id.

## Configuration

| Variable | Purpose |
|---|---|
| `OPENGENI_MICROSOFT_DYNAMICS_CLIENT_ID` | Multi-tenant Entra app (pre-registered; Microsoft has no dynamic client registration here). |
| `OPENGENI_MICROSOFT_DYNAMICS_CLIENT_SECRET` | Its client secret. Set both or neither. |
| `OPENGENI_MICROSOFT_DYNAMICS_FINANCE_OPERATIONS_ENABLED` | Accept Finance and Operations URLs. |

Finance and Operations was verified on 12 Nov 2026 against a real environment
(`opengeni-fno-test.operations.ch.dynamics.com`) through the staging connector:
card, Entra sign-in and an ERP MCP read with an explicit company. The flag is on
in Opengeni's staging and production environments.

The Entra app needs:

- redirect URI `<public API origin>/v1/integrations/oauth/callback` (Web platform);
- delegated API permissions **Dynamics CRM → user_impersonation**, **Dynamics
  365 Business Central → Financials.ReadWrite.All** and, for Finance and
  Operations, **Dynamics ERP** permissions (`mcp.tools`), plus
  Microsoft Graph `openid`, `profile`, `offline_access`;
- "Accounts in any organizational directory" (multi-tenant).

It is separate from the Microsoft 365 and Teams apps so customers can consent
to Dynamics on its own.

Refreshes use the deployment's current client secret for connections made with
this client ID, so rotating the secret (Entra secrets expire after at most two
years) needs only a config change and no reconnects. Add the new secret in
Entra, deploy it, then delete the old one.

## Connecting

- `capability_catalog_search` returns the agent-only entry
  `api:microsoft-dynamics` when the client is configured. Its setup detail
  (and `capability_authorization_request`, which answers `input_required`)
  tells the agent to ask for the environment address and call
  `custom_mcp_setup_request` with it.
- `custom_mcp_setup_request` and capability creation store any Dynamics
  environment address as its connection URL (`canonicalMcpEndpointUrl`).
- The chat card for a Dynamics URL shows "Microsoft Dynamics" with one
  Connect action; it adds the environment and opens the ordinary sign-in
  dialog. Connections default to personal ownership.

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
root on the same host (`isMicrosoftDynamicsApiDestination`). Microsoft's error
message reaches the agent; a write whose outcome is unknown (network failure,
5xx) is reported as uncertain and never retried.

## Business Central API bridge

`packages/runtime/src/business-central-api-mcp.ts` serves generic tools over
the environment's API v2.0 root with the connection's grant:
`business_central_list_companies`, `business_central_list_entities` and
`business_central_describe_entity` (from `$metadata`: properties, enum values,
navigation properties and bound actions), `business_central_query` (OData GET
relative to a company, paging with `odata.maxpagesize`), and
`business_central_create_record` / `business_central_update_record`
(`If-Match: *`) / `business_central_delete_record` /
`business_central_run_action` (bound `Microsoft.NAV.<action>`, for example
`post`). The four change tools recommend Ask first. A tool's `company` is a
name or id; it may be omitted when the environment has one company.

All Business Central environments are one Entra resource on one host, so the
token resolver lets a Business Central connection's grant reach any URL below
`https://api.businesscentral.dynamics.com/v2.0/`. A person with two connected
environments then works whichever of their connections the resolver picks
(it selects personal connections by provider domain).

Why the API rather than Microsoft's Business Central MCP server (verified on
11 November 2026 against a real tenant with the staging Entra app):

- **One URL for every environment.** `POST https://mcp.businesscentral.dynamics.com`
  picks the environment from request headers (`TenantId`, `EnvironmentName`,
  optional `Company`, `ConfigurationName`). Opengeni connections are keyed and
  bound by their MCP URL, so environments would be indistinguishable without
  per-connection headers.
- **Read-only until an admin configures it.** Without a named configuration
  the server offers only discovery tools (`bc_actions_search`,
  `bc_actions_describe`, `bc_actions_invoke`, `list_companies`) in read-only
  mode. Writes need an admin with the MCP - ADMIN permission set to publish an
  MCP configuration (page 8350) enabling create/modify per API page, and the
  client must send its `ConfigurationName`. The API needs only consent and the
  user's own licence and permission sets.
- **Awkward invocation.** `bc_actions_invoke` takes `RequestParameters` as a
  JSON-encoded string; an object fails with only "An error occurred invoking
  'bc_actions_invoke'".
- **Same consent either way.** The Entra permission (Dynamics 365 Business
  Central, delegated `Financials.ReadWrite.All`) covers both; the MCP token's
  audience is `https://mcp.businesscentral.dynamics.com`, the API's
  `https://api.businesscentral.dynamics.com`.

Server details for reference: Streamable HTTP, protocol 2025-06-18, server
"Microsoft Dynamics 365 Business Central" 29.0.57751.0; a 401 advertises
`/.well-known/oauth-protected-resource` with authority
`https://login.microsoftonline.com/common/v2.0` and no dynamic client
registration. With `Company` set, `list_companies` disappears and tool schemas
drop `company`.
