---
name: opengeni-setup
description: >-
  Set up Opengeni for a product: browser-assisted organization onboarding and
  a full-access setup key, a working embedded chat agent first, then the
  product's own tools (OpenAPI or MCP) with approvals, and optionally
  schedules, webhooks, credentials and usage budgets. Uses the Opengeni MCP
  tools when available, otherwise the coding agent's own browser, shell and
  HTTP tools.
---

# Opengeni developer setup

You are the product's coding agent. Get the product a working Opengeni chat
agent, then wire the product's own tools into it. The embedding code follows
[the embedding skill](../build-with-opengeni/opengeni-client/SKILL.md). This skill is not a runtime
Skill for the product's end-user agent.

When the `opengeni` MCP tools are available (the Opengeni plugin connects
them), use them to inspect and act on the user's Opengeni organization:
`opengeni_actions_search` finds an action, `opengeni_action_describe` shows its
input, `opengeni_action_call` runs it. Prefer them over hand-written API calls.
The first use opens a browser sign-in where the user chooses what the agent may
access. The product's server still needs its own organization API key (step 2).

[The REST/SDK walkthrough](references/setup-api.md) has the exact request
bodies, verification calls and recovery rules; read the section for a step
before executing it. Never invent a route, SDK method or permission. The
[SDK example](references/setup-sdk.ts) is typechecked against this repo.

The default path is steps 1–4: a verified chat, then verified product tools.
The user may stop after the working chat (step 3); otherwise continue to
tools. Steps 5–6 run only when the product or request needs them.

## 1. Inspect the product and target

Inspect the product's auth, tenancy, existing Opengeni config, runtime, API
(OpenAPI document or MCP server), environment-file conventions and deployment.
Reuse its sharing boundaries and explicitly requested schedule/time zone, write
policy and output destination. Derive the organization name from the product.
Do not ask the user to navigate settings, copy keys, supply API schemas, or
choose options already settled by the product/request. The only routine human
step is authentication (including verification, MFA or payment authorization).
Do not make a new external commitment when the product/request leaves it open.
Record a skipped feature rather than fabricating a URL, schedule or credential.

Default target: `https://app.opengeni.ai`. When testing, explicitly use
`https://staging.app.opengeni.ai`; never silently fall back to production.
Read unauthenticated `GET /v1/config/client`, then authenticated `/v1/access/me`.
Do not use a Personal/default workspace as the product's workspace.

## 2. Authenticate and create the organization key once

Use your browser to open the target app. Ask: **“Please authenticate in this
browser; I’ll handle the organization and developer setup.”** Let the person
complete sign-in/sign-up, email verification and MFA. Do not request their
password in chat or automate a verification challenge.

After authentication, if onboarding first asks how to use Opengeni, choose
**Run agents in the cloud**: the other path shows a key on screen, and this
setup creates its key below instead. Complete the organization-name step using
the product's name, or reuse the exact intended existing organization. A bound invitation
takes precedence; do not create a second organization. Skip optional model or
purchase onboarding when an authorized billing path already exists. A key does
not buy credits or make an unavailable model usable.

In **Organization settings → Developer → Create API key**, select
**Full access** with a 30-day expiry, so setup and testing (including test users
and a production key) need no further UI. Store the once-shown token directly in the product's server-only `.env`
(or its existing secret manager), never in chat, a screenshot, a committed
file, a browser bundle, or a `NEXT_PUBLIC_`/`VITE_` variable. Disable shell
tracing; ignore `.env` and the local setup ledger; use file mode `0600`.

If your browser cannot securely transfer a once-shown secret to the local
environment, use the authenticated browser's API client to send the exact key
request from the walkthrough and capture its response directly to a protected
file. Never print the raw response. If that secure path is unavailable, stop
at the credential-transfer blocker; do not ask for a key pasted into chat.

Verify `/v1/access/me`: the credential must be a full-access organization API
key for the intended organization. An empty `workspaceGrants` is normal for an
organization key.

## 3. Embed a working chat agent and verify a real reply

Follow the [embedding skill's default integration](../build-with-opengeni/opengeni-client/SKILL.md):
one server route from `createSessionProxyRoute`, whose `resolve` authenticates
the product's user and returns `{ user, tenant }` (one workspace per tenant) or
`{ user }` (one per user). The proxy creates workspaces and memberships on first
use; explicit `ensureWorkspace`/`asUser` provisioning is an advanced option,
not a setup step. Its `createSession` hook sets the canonical product agent:

```ts
agent: { identity: "You are Acme's assistant. Friendly and brief.", capabilities: "none" },
sandboxBackend: "none",
```

`capabilities: "none"` already limits the agent to the session's own tools plus
asking the user, with no Opengeni workspace tools, connectors or bundled
Opengeni guides, so do not add empty `tools`, `firstPartyMcpTools`,
`bundledSkillIds` or `agentLearning` overrides. The renderer defaults to
`"opengeni"` for `OpenGeniChat`; set `renderer: "markdown"` only for a UI that
renders plain Markdown. A shell-equipped coding agent is not a reason to give
the end-user agent a sandbox.

Run the product, sign in, ask a real question and read the streamed answer.
Successful HTTP creation alone is not a working chat. Confirm the reply comes
from the intended persona and the chat survives a reload. If the user only
wanted the chat, stop here and report that product tools are not wired.

## 4. Wire the product's own tools (default next step)

Prefer what the product already has. In order:

1. An existing **MCP** server: attach it per session from the `createSession`
   hook (`mcpServers` + `tools`), or expose a per-user endpoint through the
   proxy's `toolServer` (see the embedding skill's "Tools and auth"
   reference).
2. An existing **OpenAPI** API: preview its focused description, create a
   Connection only if needed, then install the exact preview revision and
   digest under a stable `instanceKey` in the tenant's workspace (from
   `og.workspaceId({ tenant })`, the same workspace the proxy uses) and select
   it by server id in `tools`.

Select only intended operations. Leave every write/destructive operation
approval-gated unless the request explicitly allows unattended writes; tool
selection and approval settings never give the product API more authority.
Inline OpenAPI documents are supported; localhost is not reachable from the
hosted deployment without a public HTTPS tunnel. The walkthrough distinguishes
MCP approval policy from API Integration `autoApprovedTools`; do not
substitute one for the other.

Verify in the embedded chat: at least one read tool actually called with the
right user's data and a useful result, and a write that asks for approval
first. `session.effectiveTools` lists what the agent can use. Never approve an
unrequested business mutation as a test.

## 5. Optional background work, callbacks and budget

Only when requested. Schedules use an installed workspace server id, not an
inline `mcpServers` entry; create them paused, reconcile the stable ledger
metadata before POST, and verify prompt, tool ids, model, time zone and status
before activating. For inbound product events, use an automation source and a
paused trigger. For outbound notifications, create a workspace webhook, protect
its once-returned signing secret, and verify metadata **and** a signed test
delivery.

If the product needs short-lived per-run credentials, PUT its workspace
credential provider, store the first response's signing secret, and verify a
signed test request. Do not rotate the secret on every rerun. The provider
must independently authorize the signed workspace/session and exact targets;
informational user/service labels grant nothing.

A usage ceiling uses workspace allowance state and its exact lifecycle version.
Amounts are integer USD micros; a ceiling is not a prepaid balance or credit
purchase. Do not guess a spending amount or alter organization billing.

Persist a non-secret local ledger (for example `.opengeni-setup/state.json`)
for any of these: target, organization id, workspace id, operation ids,
integration ids/revisions, schedule id, webhook id and provider metadata. Save
identities **before** submitting writes.

## 6. Report and hand off

Report non-secret ids, passed checks, skipped features and any remaining
blocker, and state plainly **whether product tools are wired** (which tools,
which were verified with a real call, which writes ask for approval). Do not
claim a callback or tool works after metadata-only verification. Follow the
walkthrough's error table; never “fix” a 403 by widening the key.

A short-lived setup key expiring is intentional; before shipping a long-lived
integration, provision a separately scoped runtime credential through the
authenticated organization administrator, not by granting key-management
permission to the setup key. Read the embedding skill's production checklist
before production.

Carry the appearance choice into the embed: custom-branded embeds should
match host fonts/colors/spacing/radius/theme with no UI-owned Opengeni branding;
stock shipped UI should need no cosmetic host CSS. Expect polished desktop
around 1440px/mobile around 390px and supported light/dark. Stock defects belong
to package React/CSS, not host workarounds. These are expectations, not a
passed UI qualification or a reason to broaden setup permissions.

For staging verification, delete only resources recorded as created by this
run, verify removal, and revoke its disposable key through the authenticated
administrator. Never clean up a reused product workspace or another run's
resources.
