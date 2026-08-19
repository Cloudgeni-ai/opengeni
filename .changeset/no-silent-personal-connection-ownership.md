---
"@opengeni/api-router": minor
---

Stop silently creating personal Connections when the caller never asked for one.

## Read before upgrading

**1. `configured` product-access-mode deployments lose personal Connections
entirely.** If your deployment runs `OPENGENI_PRODUCT_ACCESS_MODE=configured`
(a shared operator key rather than managed sign-in), personal Gmail, hosted
Slack MCP, Google Drive, and Atlassian connect will stop working after this
upgrade, and there is no workspace-owned alternative for the personal-only
providers. The shared configured key resolves to
`principalKind: "configured_key"`, and its subject comes from a caller-supplied
`x-opengeni-subject` header that proves nothing — a shared operator key cannot
supply the per-human consent a personal Connection represents. Existing personal
Connections in such a deployment keep working until their refresh token fails
(see below), but no new one can be created and none can be re-consented. Move to
`managed` mode if you need personal Connections. `local` mode is unaffected: its
bootstrap `dev` subject is a `human_session` and genuinely is the sole operator.

**2. Breaking for direct API/SDK callers of
`POST /v1/workspaces/:workspaceId/integrations/oauth/start`.** An omitted
`ownership` is now a **422** when the resolved provider profile allows both
ownerships; the caller must choose. Reconnects and single-ownership profiles
(Gmail, hosted Slack MCP) are unaffected, as is the web app, which always sends
an explicit value.

**3. Machine-owned personal Connections have no re-consent path.** See
"Existing rows" below for the remediation and a survey query to run first.

## What changed

The Integration Definition OAuth start resolved an omitted `ownership` to
`personal`, inverting the documented workspace-owned default. It no longer
guesses. Resolving the omission to `workspace` instead was rejected
deliberately: an executed probe confirmed it flips a newly connected Outlook
mailbox (and Drive/OneDrive) from subject-scoped to workspace-shared, which is a
real narrow-to-broad widening, and this change must only narrow or make
explicit. The MCP OAuth start keeps its existing, already-correct
`defaultOwnershipFor` behaviour.

Personal ownership is now restricted to a managed human on every path that mints
a new personal owner: MCP OAuth start, Integration Definition OAuth start,
manual `POST /connections`, first-party social OAuth start, and the
personal-only Google Drive and Atlassian install routes. An API key, the shared
`configured:` key, a service principal, an agent attempt, a grant that fails
`contextIntegrity`, or a principal substituting another subject now gets an
explicit **422** instead of a machine-owned personal Connection. That is a
refusal, never a silent downgrade — Gmail and Slack's hosted MCP are
personal-only and must not become workspace-owned. The predicate now matches the
pre-existing `requireConnectionAuthorityOwner` exactly, including its
`contextIntegrity` anti-substitution invariant; only the status code differs
(422 rejects an unavailable ownership *value*, 403 rejects a caller claiming to
*be* the owner).

An OAuth callback carries signed state, not a live principal, so it cannot
re-evaluate `principalKind`. Every start path that may persist a personal owner
now stamps a `personalOwnerVerified` claim into its HMAC-signed state, and **all
five** callbacks that can persist one — Integration Definition OAuth, MCP OAuth,
Google Drive, Atlassian, and social — require it. A state minted before the
claim existed lacks it and fails closed, which closes the one `oauthStateTtlMs`
in-flight window across a rolling deploy and is why the MCP callback's legacy
`?? "personal"` decode can no longer land a machine-owned row.

## Existing rows

No schema change and no data migration. Existing personal Connections owned by a
machine subject already sit on the `legacy_user` authority lane
(`bind_connection_authority` mints the `user` scope only for a subject with an
active organization membership), they remain listable and readable, and they
**are** runtime-resolvable today: `personalConnectionDelegationSourceForGrant`
returns a subject source for an `api_key` grant, so an api_key-owned Connection
still resolves for that api_key. Credential-broker refresh-token renewal is
untouched.

What they lose is any **re-consent path**: interactive OAuth start now 422s, the
callback fence 422s, and migration 0256 makes the owner column immutable, so the
owner cannot be converted in place. When such a Connection's stored refresh
token finally fails, the remediation is to create a replacement Connection as
workspace-owned (or personal, connected by the human who should own it),
repoint the capability at it, then revoke the stale row. Survey the population
before upgrading:

```sql
select coalesce(authority_scope, '(pre-0256)') as scope,
       split_part(subject_id, ':', 1) as subject_prefix,
       count(*)
from connections
where subject_id is not null
group by 1, 2
order by 3 desc;
```
