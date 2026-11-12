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

Finance and Operations was verified on 12 Nov 2026 against a real environment
(`opengeni-fno-test.operations.ch.dynamics.com`) through the staging connector:
card, Entra sign-in and an ERP MCP read with an explicit company. The flag is on
in Opengeni's staging and production environments.

The Entra app needs:

- redirect URI `<public API origin>/v1/integrations/oauth/callback` (Web platform);
- delegated API permissions **Dynamics CRM → user_impersonation** and, for
  Finance and Operations, **Dynamics ERP** permissions (`mcp.tools`), plus
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
root on the same host (`isDataverseWebApiDestination`). Microsoft's error
message reaches the agent; a write whose outcome is unknown (network failure,
5xx) is reported as uncertain and never retried.

## Business Central (follow-up)

Not supported yet. Verified on 11 November 2026 against a real tenant with the
staging Entra app (delegated authorization code with PKCE; device code fails
under security defaults with AADSTS530035):

- **MCP endpoint:** `POST https://mcp.businesscentral.dynamics.com`, one global
  URL for every tenant. Streamable HTTP (`Accept: application/json,
  text/event-stream`, reuse `Mcp-Session-Id`). A 401 advertises
  `/.well-known/oauth-protected-resource` with authority
  `https://login.microsoftonline.com/common/v2.0`; no dynamic client
  registration. Server "Microsoft Dynamics 365 Business Central" 29.0.57751.0,
  protocol 2025-06-18.
- **Scope:** `https://mcp.businesscentral.dynamics.com/Financials.ReadWrite.All`
  plus `offline_access` (token `aud` is the MCP host). The Entra permission is
  Dynamics 365 Business Central, delegated `Financials.ReadWrite.All`, the
  same resource as the BC API, so one consent covers both.
- **Headers:** `TenantId` (customer tenant GUID, the token's `tid`) and
  `EnvironmentName` (for example `Production`) are required; `Company` and
  `ConfigurationName` are optional. Non-ASCII header values are sent as
  `=?base64?<base64>?=`.
- **Company modes (pick one):** without `Company`, the server uses the default
  company named in its `initialize` instructions, offers `list_companies`, and
  every tool takes a required `company` argument. With `Company`,
  `list_companies` disappears, the schemas drop `company`, and passing it fails
  with "The 'company' parameter is not accepted: the company is fixed to <name>
  for this MCP session."
- **Default tools** (no named configuration): `bc_actions_search`,
  `bc_actions_describe`, `bc_actions_invoke`, `list_companies`. In
  `bc_actions_invoke`, `RequestParameters` must be a JSON-encoded string, for
  example `{"company":"CRONUS NO","ActionName":"List_Customers_PAG30009","RequestParameters":"{\"top\":3}"}`;
  an object fails with only "An error occurred invoking 'bc_actions_invoke'."
- **Configurations:** admins create named MCP configurations on BC page 8350
  for more than the default read-only discovery. `GET
  https://mcp.businesscentral.dynamics.com/$configurations` returns 400
  `RequestDataInvalid` when none exists, so don't depend on it.
- **BC API alternative** (same consent, no page-8350 setup): scope
  `https://api.businesscentral.dynamics.com/Financials.ReadWrite.All`, for
  example `GET https://api.businesscentral.dynamics.com/v2.0/<tenant>/<environment>/api/v2.0/companies`.
- **Licensing:** no MCP-specific fee found; calls run as a licensed BC user.

What remains: a connection target for BC (the environment name and tenant
rather than a host URL), the per-connection headers or an API bridge,
including `RequestParameters` string encoding, the BC Entra permission in the
profile's scopes, and catalog/guide rows. Re-request consent from existing
customers when the BC permission is added.
