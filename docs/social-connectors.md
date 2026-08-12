# Social connectors (X / Reddit)

First-party connectors that let workspace agents read live conversations and
reply on X and Reddit. Tokens are stored encrypted in `social_connections` and
used only host-side; agents never see credentials, only normalized posts.

## Operator setup

1. Create OAuth apps with the providers:
   - **X**: an OAuth 2.0 app (confidential client recommended) at
     https://developer.x.com. Callback URL:
     `<OPENGENI_PUBLIC_BASE_URL>/v1/social/oauth/callback`. Scopes used by
     default: `tweet.read tweet.write users.read offline.access`.
   - **Reddit**: a "web app" at https://www.reddit.com/prefs/apps with the same
     callback URL. Scopes used by default:
     `identity read submit privatemessages history`.
2. Configure the clients:

   ```bash
   OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON='{"x":{"clientId":"...","clientSecret":"..."},"reddit":{"clientId":"...","clientSecret":"..."}}'
   ```

   Also required (shared with the integrations OAuth flow):
   `OPENGENI_INTEGRATIONS_STATE_SECRET` and
   `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`.

## Connecting accounts

In the web app, open **Capabilities → X** and choose either **Connect for
workspace** (the default) or **Connect only for me**.
The provider card lists every account visible under the selected ownership,
with an independent lifecycle and disconnect action for each row. **Add another
account** starts a new OAuth flow instead of replacing an existing account. A
card remains visible when one or more accounts need reconnection, so repair and
healthy sibling accounts do not disappear behind a singleton projection.

`POST /v1/workspaces/:id/social/oauth/start` with
`{"provider": "x", "ownership": "workspace"}` or
`{"provider": "reddit", "ownership": "personal"}` returns an `authorizationUrl`;
open it in a browser and approve. The callback upserts a `social_connections`
row. Repeated consent for the same provider principal updates that account;
consent for a different principal creates another account. Workspace ownership
requires `workspace:admin`; personal ownership requires workspace membership
and remains visible only to that subject. SDK:
`client.startSocialOAuth(workspaceId, { provider: "x" })`, then
`client.listSocialConnections(workspaceId)`.

Access tokens are refreshed automatically just-in-time (X rotates refresh
tokens; Reddit keeps one). When refresh becomes impossible the connection
flips to `needs_reauth` and tools return an actionable error.

## Agent tools (first-party MCP)

Provider-scoped read tools are gated on `connections:read`:

- X: `x_accounts_list`, `x_search_live`, `x_mentions_live`,
  and `x_thread_fetch`.
- Reddit: `reddit_accounts_list`, `reddit_search_live`,
  `reddit_mentions_live`, and `reddit_thread_fetch`.

The account-list tools return only accounts for their named provider. Every
live tool accepts an exact `connectionId` and verifies that the connection's
provider matches the tool namespace before any provider call. For example,
passing a Reddit connection to `x_search_live` fails closed rather than routing
through a generic social adapter. Reddit search may use `subreddit` to scope a
query.

Provider-scoped write tools are gated on `connections:write` and are never in
the default agent permission set:

- `x_post_reply` publishes an X reply using a tweet id.
- `x_posts_sync` idempotently stores an X account's recent posts in
  `social_posts`.
- `reddit_post_reply` publishes a Reddit reply using a fullname (`t3_…` post /
  `t1_…` comment).
- `reddit_posts_sync` idempotently stores a Reddit account's recent posts in
  `social_posts`.

Sync requires write authority because it mutates OpenGeni's durable analysis
store, even though it does not publish to the provider. Pair either reply tool
with a `requireApproval` policy when a human should sign off on every outbound
post.

Aggregate Pack tools remain provider-neutral: `social_connections_list`,
`social_posts_recent`, and `social_daily_analysis_context` compose X and Reddit
data for cross-provider workflows. The older `social_search_live`,
`social_mentions_live`, `social_thread_fetch`, `social_posts_sync`, and
`social_post_reply` names remain registered for rolling compatibility, but new
explicit policies and provider catalog cards use the provider-scoped names.

## Identity model

Workspace-owned social connections are available to workspace agents and
scheduled tasks, so connect a dedicated brand account for unattended marketing
loops. Personal social connections use the same frozen causal authority model
as personal MCP credentials: direct work snapshots the current subject's exact
connection, children and user-created schedules inherit that snapshot, and
unrelated service work cannot discover or borrow it.

## Composing the marketing loop with scheduled tasks

The intended pattern — opengeni owns connector + schedule, the prompt owns
judgment:

1. Connect X/Reddit (above) and put mission/brand-voice knowledge in a
   document base (e.g. the marketing pack's `marketing-playbook`).
2. Create a scheduled task (interval or calendar) whose prompt directs the
   agent to: search/fetch mentions with the live tools, judge relevance
   against the playbook documents, and write reply drafts into a document or
   session output for review.
3. Keep `x_post_reply` and `reddit_post_reply` behind `connections:write` (and
   optionally tool-call approval) so publishing stays a deliberate step.
