# Publish a Site app to the web: viewers, limits and audiences

"Publish to the web" in SKILL.md covers the address, access and warnings.
Read this when an invited or public Site uses Site Data, Site SQL, workspace
tools or an embedded agent.

## Viewers, the embedded agent and limits

- Viewer: `const viewer = await site.viewer` gives `{ kind, id, name, email,
  signedIn }` (`kind`: `member`, `invited`, `user` or `guest`), or `null` on
  hosts that don't report viewers. Guests have no name or email. Offer a
  sign-in button that calls `site.auth.signIn()`; never build your own login.
- Embedded agent and limits: the publication turns the Site's agent on or
  off and picks its model. Workspace members are never limited by the Site.
  People outside the workspace share one Site limit ($10 a month by
  default) and an optional per-person limit, which workspace admins set;
  anonymous guests also meet bot guards. Non-member model calls use organization
  credits; members keep their normal billing, including subscriptions. Handle
  `rate_limited`, `site_budget_exhausted` and retryable `site_budget_busy` (429), and
  `site_platform_brake_engaged` (503) as normal UI states.
- The same Site HTML and Site Data work there; no rebuild is needed.
- Published-host agents get this Site's `site_data_query` and `site_data_write`,
  plus `site_sql_run` when SQL is enabled; members also get read-only `site_sql_query`.
  Member tools are intersected with live permissions: a member without artifact
  publishing can still use AI without write tools, and without data-read permission
  can use plain AI without data tools. Never request extra permission just to chat.
  The server pins the Site and binds calls to the conversation's viewer, including
  collection ownership and query audiences. No management tools or sandbox are
  supplied; publication settings have no sandbox opt-in. Members get no Site
  budget or stamped session usage limit. Existing Sites pick up defaults without
  republishing. Platform allowances and the global brake never count model spend.

**Build for the audience.** A published page can do only what its viewer
may do. People outside the workspace (invited people and public visitors)
never get workspace tools, and the Site's agent gives them none either; a
subscription model (Codex, Claude or SuperGrok plan) is swapped for the
workspace's credit-billed default for them. So for an invited or public
Site:

- keep the data the page needs in Site Data or Site SQL, not behind
  workspace tools; call `site.tools` only in parts shown to members;
- give guests the least they need: a collection's `guestAccess`, and
  `everyone` only on queries guests must run;
- read `const caps = await site.capabilities` (`null` on hosts that don't
  report it) and hide what this viewer can't use: `caps.agent`,
  `caps.workspaceTools`, `caps.siteData` (`viewer` or `guest`) and
  `caps.sqlQueryAudiences`; `caps.viewAs` is set while a member previews the
  Site as a visitor;
- treat `not_available_for_viewer` (403) as a friendly state, never a crash.

Apply a warning's safe `fix` with `opengeni__site_publication_apply_fix` (a
collection's guest access or a query's audience) when the user wants that
audience to have it, or change the page. Render viewer names, emails, records
and agent replies with `textContent` or React text, never `innerHTML`.

