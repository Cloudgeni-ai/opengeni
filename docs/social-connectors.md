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

## Connecting an account

`POST /v1/workspaces/:id/social/oauth/start` (workspace:admin) with
`{"provider": "x"}` or `{"provider": "reddit"}` returns an `authorizationUrl`;
open it in a browser and approve. The callback upserts a `social_connections`
row (reconnecting the same handle replaces the credential). SDK:
`client.startSocialOAuth(workspaceId, { provider: "x" })`, then
`client.listSocialConnections(workspaceId)`.

Access tokens are refreshed automatically just-in-time (X rotates refresh
tokens; Reddit keeps one). When refresh becomes impossible the connection
flips to `needs_reauth` and tools return an actionable error.

## Agent tools (first-party MCP)

Read tools (gated on `connections:read`):

- `social_connections_list` — find connectionIds.
- `social_search_live` — X recent search / Reddit search (`subreddit` to scope).
- `social_mentions_live` — X mentions timeline / Reddit inbox (mentions + replies).
- `social_thread_fetch` — X conversation / Reddit post + top comments.
- `social_posts_sync` — pull the account's own recent posts into `social_posts`
  (idempotent) so `social_posts_recent` and daily analysis stay fresh.

Write tool (gated on `connections:write`, never in the default agent
permission set):

- `social_post_reply` — publish a reply. X takes a tweet id; Reddit takes a
  fullname (`t3_…` post / `t1_…` comment). Pair it with a `requireApproval`
  policy when a human should sign off on every outbound post.

## Composing the marketing loop with scheduled tasks

The intended pattern — opengeni owns connector + schedule, the prompt owns
judgment:

1. Connect X/Reddit (above) and put mission/brand-voice knowledge in a
   document base (e.g. the marketing pack's `marketing-playbook`).
2. Create a scheduled task (interval or calendar) whose prompt directs the
   agent to: search/fetch mentions with the live tools, judge relevance
   against the playbook documents, and write reply drafts into a document or
   session output for review.
3. Keep `social_post_reply` behind `connections:write` (and optionally
   tool-call approval) so publishing stays a deliberate step.
