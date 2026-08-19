---
"@opengeni/api-router": minor
---

Stop silently creating personal Connections when the caller never asked for one.

`POST /v1/workspaces/:workspaceId/integrations/oauth/start` resolved an omitted
`ownership` to `personal`, inverting the documented workspace-owned default for
every caller that did not spell it out. It now takes the resolved provider
profile's default (`defaultOwnershipFor`) — workspace for every curated Google
and Microsoft Definition — and applies that profile's `allowedOwnership` fence,
matching the MCP OAuth start. The web app already sends an explicit ownership,
so only direct API/SDK callers change behaviour.

Personal ownership is now restricted to a managed human on every create path
(MCP OAuth start, Integration Definition OAuth start, manual `POST
/connections`, first-party social OAuth start, and the personal-only Google
Drive and Atlassian install routes, plus their callbacks). An API key, the
shared `configured:` key, a service principal, an agent attempt, or a principal
substituting another subject now gets an explicit **422** instead of a
machine-owned personal Connection. That is a refusal, never a silent downgrade —
Gmail and Slack's hosted MCP are personal-only and must not become
workspace-owned. `principalKind` is the trusted signal, with an
`api_key:`/`configured:` subject-prefix check as belt-and-braces and as the only
signal an OAuth callback (signed state, no live principal) has.

No data migration and no schema change. Existing personal Connections owned by a
machine subject are untouched: they already sit on the `legacy_user` authority
lane (`bind_connection_authority` can mint the `user` scope only for a subject
with an active organization membership), they remain listable and readable, and
runtime resolution through a frozen delegation snapshot is unchanged. The one
behaviour they lose is interactive OAuth *reconnect* under the same non-human
principal, which now 422s; stored refresh-token renewal through the credential
broker is unaffected. Operators can survey the population read-only with:

```sql
select coalesce(authority_scope, '(pre-0256)') as scope,
       split_part(subject_id, ':', 1) as subject_prefix,
       count(*)
from connections
where subject_id is not null
group by 1, 2
order by 3 desc;
```
