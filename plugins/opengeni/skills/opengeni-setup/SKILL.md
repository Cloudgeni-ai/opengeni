---
name: opengeni-setup
description: >-
  Set up OpenGeni for a product before writing its embedding code. Use for
  browser-assisted organization onboarding, a scoped Developer setup key,
  idempotent REST/SDK workspace provisioning, agent persona and capabilities,
  product tools, approvals, schedules, webhooks, credentials and usage budgets.
  Skills only: the coding agent uses its own browser, shell and HTTP tools;
  no OpenGeni MCP server or plugin UI is required.
---

# OpenGeni developer setup

You are the product's coding agent. Configure OpenGeni through its public API,
then hand off to [the embedding skill](../build-with-opengeni/opengeni-client/SKILL.md). This skill
is not a runtime Skill for the product's end-user agent. Installing the plugin
does not install an MCP server or grant an API key.

Read [the exact REST/SDK walkthrough](references/setup-api.md) before executing
setup. It contains the request bodies, verification calls and recovery rules.
Use the numbered order below; never invent a route, SDK method or permission.
The [SDK example](references/setup-sdk.ts) is typechecked against this repo.

## 1. Inspect the product and target

Inspect the product's auth, tenancy, existing OpenGeni config, runtime, tools,
environment-file conventions and deployment. Reuse its sharing boundaries and
explicitly requested schedule/time zone, write policy and output destination.
Derive the organization name and stable `externalSource` from the product.
Do not ask the user to navigate settings, copy keys, supply API schemas, or
choose options already settled by the product/request. The only routine human
step is authentication (including verification, MFA or payment authorization).
Do not make a new external commitment when the product/request leaves it open.
Configure optional features only when the product needs them; record a skipped
feature rather than fabricating a URL, schedule or credential.

Default target: `https://app.opengeni.ai`. When testing, explicitly use
`https://staging.app.opengeni.ai`; never silently fall back to production.
Read unauthenticated `GET /v1/config/client`, then authenticated `/v1/access/me`.
Do not use a Personal/default workspace as the product's workspace.

## 2. Authenticate and create the organization key once

Use your browser to open the target app. Ask: **“Please authenticate in this
browser; I’ll handle the organization and developer setup.”** Let the person
complete sign-in/sign-up, email verification and MFA. Do not request their
password in chat or automate a verification challenge.

After authentication, complete the organization-name step using the product's
name, or reuse the exact intended existing organization. A bound invitation
takes precedence; do not create a second organization. Skip optional model or
purchase onboarding when an authorized billing path already exists. A key does
not buy credits or make an unavailable model usable.

In **Organization settings → Developer → Create API key**, select
**Developer setup**, not Full access/all permissions. Keep its short default
expiry. Store the once-shown token directly in the product's server-only `.env`
(or its existing secret manager), never in chat, a screenshot, a committed
file, a browser bundle, or a `NEXT_PUBLIC_`/`VITE_` variable. Disable shell
tracing; ignore `.env` and the local setup ledger; use file mode `0600`.

If your browser cannot securely transfer a once-shown secret to the local
environment, use the authenticated browser's API client to send the exact key
request from the walkthrough and capture its response directly to a protected
file. Never print the raw response. If that secure path is unavailable, stop
at the credential-transfer blocker; do not ask for a key pasted into chat.

Verify `/v1/access/me`: the credential must be an organization API key for the
intended organization with the Developer setup permissions. An empty
`workspaceGrants` is normal for an organization key. If this preset is missing
on the target, report a deployment-version mismatch; do not substitute Full
access or a workspace key.

## 3. Provision and verify the organization workspace

Persist a non-secret local ledger (for example `.opengeni-setup/state.json`):
target, organization id, stable external source/id, workspace id, operation
ids, session id, integration ids/revisions, schedule id, webhook id and
provider metadata. Save identities **before** submitting writes.

Call `PUT /v1/workspaces/external` / `ensureWorkspace` with the stable product
tenant mapping. Save `result.workspace.id`; `created: false` is a successful
rerun, not an error. Verify `GET /v1/workspaces/:id` has the intended account,
external mapping and wire kind `"shared"`. Do not overwrite an existing
workspace's name, persona or settings just because ensure returned it.

## 4. Configure agent defaults and product users

Read client config for this exact workspace and its existing settings.
If `agentConfig.enabled`, set `sessionAgentDefaults` with the product persona,
`capabilities` starting from `"none"`, and the correct renderer. Verify the
workspace read and later `session.agent`/`session.effectiveTools`. Never send
an unavailable capability. A shell-equipped coding agent is not a reason to
give the end-user agent shell access: default pure tool/chat sessions to
`sandboxBackend: "none"`.

On an older/admission-disabled deployment, do not send `agent` or
`sessionAgentDefaults`; use explicit `instructions`, `firstPartyMcpTools: []`,
`tools` and `bundledSkillIds: []` when creating sessions and report the missing
agent-default feature. This is a documented compatibility path, not a claim
that workspace agent defaults were configured.

For a product acting as its authenticated users, grant the exact external
member set once with a saved `operationId`; verify membership. The server must
authenticate users and pin their workspace before `asUser`. Do not treat
`endUser` labels, Knowledge settings or tool selection as tenant isolation.

## 5. Configure product tools and approvals

Prefer the product's existing OpenAPI API. Preview its focused description,
create a Connection only if needed, then install the exact preview revision
and digest under a stable `instanceKey`. Select only intended operation ids;
leave write/destructive operations approval-gated unless the request explicitly
allows unattended writes. Verify installed instance, selected tools and an
actual safe tool call. Inline OpenAPI documents are supported; localhost is
not reachable from the hosted deployment without a public HTTPS tunnel.

If the product already has MCP, attach its server to sessions with write-only
headers or a Connection reference, `allowedTools` and `requireApproval`.
Those are **the product's** remote tools, not an OpenGeni MCP plugin. Schedules
use an installed workspace server id, not an inline `mcpServers` entry.
The walkthrough distinguishes MCP approval policy from API Integration
`autoApprovedTools`; do not substitute one for the other.

## 6. Configure requested background work and callbacks

Create schedules paused; reconcile the stable ledger metadata before POST.
Verify their prompt, tool ids, model, time zone and status before activating.
For inbound product events, use an automation source and paused trigger.
For outbound notifications, create a workspace webhook and protect its
once-returned signing secret. Verify metadata **and** a signed test delivery.

If the product needs short-lived per-run credentials, PUT its workspace
credential provider, store the first response's signing secret, and verify a
signed test request. Do not rotate the secret on every rerun. The provider
must independently authorize the signed workspace/session and exact targets;
informational user/service labels grant nothing.

## 7. Set the usage ceiling and run a smoke session

Use workspace allowance state and its exact lifecycle version to set the
product's requested budget. Amounts are integer USD micros; a ceiling is not a
prepaid balance or credit purchase. Verify allowance and usage reads. Do not
guess a spending amount or alter organization billing.

Create the smoke session with a saved `idempotencyKey`, explicit tools and
compute, and a model available in this workspace's client config. Read its
session and events until the first answer or actionable refusal. Successful
HTTP creation alone is not a working session. Confirm persona/capabilities,
actual safe product-tool execution when tools were configured, and intended
approval behavior. Follow the walkthrough's error table; never “fix” a 403 by
widening the key.

## 8. Write the embedding code and hand off

Follow [opengeni-client](../build-with-opengeni/opengeni-client/SKILL.md) using the verified
workspace mapping and server-held key. Keep the embedding skill's existing
proxy/authentication boundary. A short-lived setup key expiring is intentional;
before shipping a long-lived integration, provision a separately scoped runtime
credential through the authenticated organization administrator, not by granting
key-management permission to the setup key.

Carry the appearance choice into that handoff: custom-branded embeds should
match host fonts/colors/spacing/radius/theme with no UI-owned OpenGeni branding;
stock shipped UI should need no cosmetic host CSS. Expect polished desktop
around 1440px/mobile around 390px and supported light/dark. Stock defects belong
to package React/CSS, not host workarounds. Preserve first-try evidence; in
coordinated trials the coordinator captures the browser matrix. Do not require
screenshot submission for the coding-agent handoff. These are expectations,
not a passed UI qualification or a reason to broaden setup permissions.

For staging verification, delete only resources recorded as created by this
run, verify removal, and revoke its disposable key through the authenticated
administrator. Never clean up a reused product workspace or another run's
resources. Hand off non-secret ids, passed checks, skipped features and any
remaining blocker; do not claim a callback or tool works after metadata-only
verification.