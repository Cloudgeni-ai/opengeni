# Publish an app to the web: viewers, limits and audiences

"Publish to the web" in SKILL.md covers the address, access and warnings.
Read this before publishing or sharing an app that uses app data, app SQL,
workspace tools or an embedded agent.

## Review who sees what

Before publishing or sharing, review who can read and write each collection
and SQL query, and where the data flows. Data fetched with a viewer's
personal connection (such as their Gmail) stays with that viewer: never write
it into shared collections or queries unless the user explicitly wants that.
app SQL rules are only as safe as their `:viewer` filters, so check each
query. Then tell the user in plain words who sees what. An app that uses
personal-account tools shows clear connect states from
`site.tools.$readiness`, so it works for teammates who have not connected yet.

## Viewers, the embedded agent and limits

- Viewer: `const viewer = await site.viewer` gives `{ kind, id, name, email,
  signedIn }` (`kind`: `member`, `invited`, `user` or `guest`), or `null` on
  hosts that don't report viewers. Guests have no name or email. Offer a
  sign-in button that calls `site.auth.signIn()`; never build your own login.
- Embedded agent and limits: the publication turns the app's agent on or
  off and picks its model. The published page draws no chat of its own; the
  agent is reachable only through the app's code. So when the user turns the
  agent on or wants people to chat and the app has no conversation surface,
  add one that suits the app (an "Ask the board" panel, a question box; see
  ai-and-chat.md), shown only while `caps.agent` is true. Workspace members are never limited by the app.
  People outside the workspace share one app limit ($10 a month by
  default) and an optional per-person limit, which workspace admins set;
  anonymous guests also meet bot guards. Non-member model calls use organization
  credits; members keep their normal billing, including subscriptions. Handle
  `rate_limited`, `site_budget_exhausted` and retryable `site_budget_busy` (429), and
  `site_platform_brake_engaged` (503) as normal UI states.
- The same app HTML and app data work there; no rebuild is needed.
- A member's conversation is their ordinary private chat (see ai-and-chat.md):
  ordinary chat defaults, or an existing chat's own saved selections, within the
  member's live permissions decide its tools and compute, and it has no app
  budget or stamped session usage limit. Members without publishing or data
  permissions can still chat; never request extra permission just to chat.
- People outside the workspace get only this app's `app_data_query` and
  `app_data_write`, plus `app_sql_run` when SQL is enabled. The server pins the
  app and binds calls to the conversation's viewer, including collection
  ownership and query audiences. They get no management or workspace tools and
  no sandbox; publication settings have no sandbox opt-in. Their existing
  conversations pick up new defaults without republishing.
- Platform allowances and the global brake never count model spend.

**Build for the audience.** A published page can do only what its viewer
may do. People outside the workspace (invited people and public visitors)
never get workspace tools, and the app's agent gives them none either; a
subscription model (Codex, Claude or SuperGrok plan) is swapped for the
workspace's credit-billed default for them. So for an invited or public
app:

- keep the data the page needs in app data or app SQL, not behind
  workspace tools; call `site.tools` only in parts shown to members;
- give guests the least they need: a collection's `guestAccess`, and
  `everyone` only on queries guests must run;
- read `const caps = await site.capabilities` (`null` on hosts that don't
  report it) and hide what this viewer can't use: `caps.agent`,
  `caps.workspaceTools`, `caps.siteData` (`viewer` or `guest`) and
  `caps.sqlQueryAudiences`; `caps.viewAs` is set while a member previews the
  app as a visitor;
- treat `not_available_for_viewer` (403) as a friendly state, never a crash.

Apply a warning's safe `fix` with `opengeni__app_publication_apply_fix` (a
collection's guest access or a query's audience) when the user wants that
audience to have it, or change the page. Render viewer names, emails, records
and agent replies with `textContent` or React text, never `innerHTML`.

