# Published Sites

Audience: people who publish Sites, developers who write Site code, and
engineers who run or change the Sites gateway and the site-runtime API.

A workspace Site normally opens only inside the console, for members of its
workspace. Publishing gives the same Site its own address under the
deployment's Sites domain (`team-crm-4k9x.opengeni.site` in production), for
workspace members, invited people or everyone. The Site's HTML, its tools,
[Site Data](site-data.md) and its embedded agent work the same way there,
under limits the organization pays for. The design record is
[published-sites-2026-10-14.md](design/published-sites-2026-10-14.md); the
shared types are in `packages/contracts/src/site-publishing.ts`.

## Publishing a Site

Open the Site and choose **Publish**. The **Publish to web** page sets:

- **Address**: one DNS label under the Sites domain. The suggestion is the
  title plus a random suffix. Labels are 3-63 characters of `a-z`, `0-9` and
  `-`, with no leading or trailing hyphen and no `xn--`-style prefix. They
  are unique across every workspace, and reserved names and brand or
  credential words are refused. The page checks the name as you type.
  Changing the address moves the Site; a released name stays held for its
  workspace for 30 days, also when the Site or its workspace is deleted.
- **Who can open it**: workspace members, invited people, or anyone with the
  link (see below).
- **Embedded agent**: whether visitors can chat with the Site's agent, and
  which model it uses.
- **Limits**: Free, Credits, Unlimited or Custom (see below).
- **Hide from search engines**: sends `X-Robots-Tag: noindex`. On by
  default, and locked on where the deployment forces it.

Only the Site's owner and workspace admins with `artifacts:publish` see the
button. A Site must be shared with its workspace first; an **Only me** Site
can't be published. **Unpublish** takes the Site offline at once and keeps
its address reserved; publishing again brings it back on the same address.

Agents can do the same with the first-party tools `site_publication_get`,
`site_publication_update` and `site_hostname_check`, within the same
permissions as the person they act for.

## Access modes

| Mode      | Who can open it                                               | Sign-in  |
| --------- | ------------------------------------------------------------- | -------- |
| `members` | Members of the Site's workspace                               | Required |
| `invited` | Members, plus the email addresses on the Site's invite list   | Required |
| `public`  | Anyone. Visitors who don't sign in are guests                 | Optional |

Invited people sign in to Opengeni with the invited email. They don't join
the organization or workspace and see nothing else in it. The API checks
access again on every call, so removing an address or changing the mode
takes effect on the next request.

Anonymous visitors of a public Site are guests: `guest:<visitorId>`, where
the visitor id comes from a cookie the gateway signs. Guests aren't users,
members or external actors; they exist only inside site-runtime, with their
own limits.

## Viewers and sign-in in Site code

Site code reads who is viewing from `site.viewer` and can ask the host to
sign the viewer in:

```ts
import { createOpenGeniSiteClient } from "@opengeni/sdk/site";

const site = createOpenGeniSiteClient();
const viewer = await site.viewer; // null on hosts that don't report viewers
if (viewer && !viewer.signedIn) {
  signInButton.hidden = false;
  signInButton.onclick = () => site.auth.signIn();
}
greeting.textContent = viewer?.name ?? "Welcome";
```

A viewer is `{ kind, id, name, email, signedIn }`. `kind` is `member`,
`invited`, `user` (a signed-in person on a public Site) or `guest`. `id` is
stable per Site and is the Site Data owner principal (`user:<subject>` or
`guest:<visitor>`); it means nothing outside that Site. Guests have no name
or email. In the console the viewer is the signed-in member and
`site.auth.signIn()` resolves at once.

Sign-in is a redirect. The gateway sends the visitor to the app's
`/site-auth/authorize` page with a state value and a PKCE challenge. The
page asks the person to continue to that Site as themselves; the app mints a
one-time code bound to the host, challenge and callback, and the gateway
exchanges it server-to-server for a session that works only on that Site
(12 hours idle, 7 days at most). No Opengeni credential ever reaches a Site
origin. A person who may not open the Site sees why and can switch account.

## Site Data for guests

Members, invited people and signed-in users follow each collection's access
mode as described in [Site Data](site-data.md). Guests get nothing unless the
collection's guest rule (`guestAccess`, set by agents when they define the
collection) allows it:

| Guest rule | Guests can                                      | Good for              |
| ---------- | ----------------------------------------------- | --------------------- |
| `none`     | nothing (the default)                           | private team data     |
| `read`     | read what viewers read                          | public listings       |
| `append`   | add records and read their own                  | contact forms, polls  |
| `own`      | add, read, change and delete their own records  | anonymous wish lists  |

Guest records belong to the guest's visitor id, so a guest who clears
cookies loses them. Guest writes have their own rate limit.

## Site SQL (optional)

Where the deployment turns on Cloudflare storage, an owner can give a Site
its own SQLite database (one Durable Object per Site) next to Site Data.
Agents define the schema as migrations and the queries the Site may run;
Site code calls them by name with `site.sql.run(name, params)` and never
sends SQL. Each named query has an audience: `everyone` (guests too),
`signed_in` (the default; viewers signed in as a person) or `managers`
(never from a Site page).
Opengeni binds `:viewer` from the signed-in viewer or guest, so a Site
cannot act as someone else. Data can always be exported as SQL, CSV or
JSON (in pieces with a cursor for large databases), even while the database
is turned off or after the deployment stops offering Site SQL, as long as
the gateway origin and secret stay configured. Details and limits are in
[Site Data: Site SQL](site-data.md#site-sql-optional-cloudflare-storage).

## Embedded agents

When the embedded agent is on, visitors can start conversations with it from
the Site. Each conversation runs as the Site's own service principal with
narrow permissions and the publication's model and instructions, without a
sandbox or shell (a publication has no sandbox setting, so Site agents never
get one). For people outside the workspace a per-conversation spend cap is
in place before the first model call; workspace members' conversations get
no Site cap and no stamped session usage limit, only the workspace's normal
limits.

Every conversation (members, invited people and guests) gets the Site's own
data tools, pinned on the server to this Site and acting as the
conversation's viewer, so they see and change only what that person could
on the page (per-viewer collections, owner binding, `:viewer` and query
audiences such as `signed_in` or `managers`): `site_data_query`,
`site_data_write`, `site_sql_run` for named queries when Site SQL is on, and
the read-only `site_sql_query` for members when Site SQL is on. Calls for
another Site and every Site management tool (publication, migrate, define,
reset, import, export, enable, files) are refused. Members also get the
overlap of the Site's declared workspace tools and their own permissions
(below); people outside the workspace get the Site's own data tools only. A
visitor can list, read and continue only their own conversations on that
Site, and sees a Site-safe view of them (no workspace ids, instructions,
tools or metadata). Agents started from a Site can't create or change
schedules, automations, Site publications or workspace settings, and can't
read other sessions; their API writes are held to an allowlist (see
`docs/site-conversations.md`).
Public Sites can let guests chat too; the Site's limits and the deployment
decide. Guest agents can optionally require a human check
(`OPENGENI_SITES_GUEST_AGENT_HUMAN_CHECK` with the gateway's Turnstile
keys); it is off by default but recommended for public Sites with guest
agents.

The agent's model follows the viewer. Workspace members use the Site agent's
model, subscriptions (Codex, Claude or SuperGrok plans) included. People
outside the workspace never use a member's subscription: when the Site's
model is subscription-billed they use the workspace's default credit-billed
model instead, and when the workspace has none they are refused
(`not_available_for_viewer`, `feature: "agent_model"`), also when an
existing conversation holds a subscription model. The publication's
`outsideAgentModel` names the model they get.

Workspace tools (MCP connections) act with the workspace's shared
connections, so only a workspace admin can give them to a Site's agent, and
only workspace members who may use connections (`mcp_servers:attach` or
admins) get them. People outside the workspace (invited people, signed-in
visitors and guests) never get workspace tools; they use the Site's own data
(Site Data and Site SQL) and the page. `agent.guestTools` is retired: it is
accepted and ignored, and always reads `false`. An agent started from a
Site page gets only the tools the Site declared (intersected with the
member's permissions), and can create, edit or export documents,
spreadsheets and presentations only when the Site declares a first-party
editing tool, and only artifacts created within that Site-clamped session tree.
The server checks the immutable create/import receipt, not a recent-use link:
reading an unrelated workspace artifact does not grant permission to edit or
export it. Parent and child sessions in that clamped tree share their creations;
another conversation on the same Site does not. No explicit existing-artifact
declaration field is exposed yet. Normal artifact permissions still apply.
A session a Site page starts in the console gets only the
first-party tools the Site declares plus the Site's own data tools (never
the workspace default set) and no sandbox. Console-frame workspace connections
are narrowed to the exact declared tool names through `ToolRef.allowedTools`,
intersected with the connection's own allowlist and the member's authority. A
connection the workspace doesn't have is skipped rather than failing the
conversation.
Unpublishing, taking down, or narrowing a Site's access signs all its viewers
out (those who keep access sign in again) and cancels its running
conversations; turning the agent off cancels the conversations only.
Removing a tool cancels the conversations that hold it, and those
conversations take no more messages.

## What each audience can do

A Site's page can do anything its viewer may do, and no more. Invited and
public Sites are checked when they are published and whenever the
publication is read: a conservative static reading of the page source, the
Site's declared tools, its Site Data collections and its Site SQL queries
produces `warnings` on the publication (and in the publication MCP tools).
Each warning says in plain language what won't work and for whom, what to
change, and, where it is safe, carries a one-click fix applied through the
ordinary APIs (`POST .../publication/fixes`): a collection's guest access
or a named query's audience. Members-only Sites have no warnings.

| Warning                            | Means                                                                 |
| ---------------------------------- | --------------------------------------------------------------------- |
| `workspace_tools_members_only`     | The page calls workspace tools, which work only inside Opengeni       |
| `agent_tools_members_only`         | The agent's workspace tools are for members who may use connections  |
| `site_data_guest_read` / `_write`  | Guests can't read, add or change a collection the page uses (fixable) |
| `site_data_members_write`          | A `shared_read` collection the page writes; only managers write it    |
| `site_sql_query_signed_in`         | A query needs a signed-in viewer; guests can't run it (fixable)       |
| `site_sql_query_managers`          | A managers-only query the page runs (fixable)                         |
| `agent_model_outside_unavailable`  | Outsiders get no agent: no credit-billed model                        |
| `page_not_checked`                 | The page is over 2 MB, so what it uses was not checked                |

When the agent's model is a subscription and outsiders use a credit-billed
model instead, that is not a warning: the publication's `outsideAgentModel`
names it and the dialog shows one quiet line. (`agent_model_outside_fallback`
is no longer reported.)

### Readiness check

The check reads the published version's stored HTML (up to 2 MB; a larger
page reports `page_not_checked`) once per version and caches the result.
It is conservative and never blocks publishing:

- a collection is used when the page names it in `collection("name")`, and
  written when that expression, or a variable assigned from it, calls
  `insert`, `put`, `patch`, `delete` or `increment`;
- a named query is used when the page calls `sql.run("name")`;
- workspace tools are used when the version requests tools, or the page
  calls `tools.<server>.<tool>` or `tools.$call`.

Names built at run time are not seen, so a clean result is not a proof; use
**View as visitor** to try the page as its audience would.

At run time, everything a viewer's audience can't do answers 403 with
`details.code` `not_available_for_viewer` and a `feature` (`agent`,
`agent_model`, `workspace_tools`, `site_data`, `site_sql`), so a page can
show a friendly state. In this release, `details.legacyCode` also
carries the code older pages matched on (`site_agents_unavailable`,
`site_tools_unavailable`, or `forbidden` for Site Data and Site SQL). A
Site Data refusal about one record (one the viewer doesn't own) keeps its
own Site Data code. Pages can avoid the error entirely by reading
`site.capabilities` (from `site.config`): `agent`, `workspaceTools`,
`siteData` (`viewer` or `guest`), `sqlQueryAudiences` and `viewAs`.

**View as visitor.** A workspace member can open the published Site as an
invited person or a public visitor would see it (the Publish page's **View
as visitor** link, or `?og_view_as=invited|public` on any page; `off` ends
it). The gateway records the preview on the member's own site session and
shows a footer banner with **Exit preview**. The preview only ever shows
less: the member is treated as that role for everything (limits, tools,
data and SQL), anyone who isn't a member is refused, and a role that can't
open the Site shows the refusal with an exit link.

## Limits and billing

The organization pays for everything a published Site does, metered into the
credit ledger like Site Data. The edge only brakes floods; Opengeni enforces
the Site's limits before every conversation and message. Limits follow who
the viewer is:

- **Workspace members** are never capped by a Site. Their conversations
  keep the ordinary workspace usage limits and budgets, never count toward
  the Site's limit, and keep the agent when it is off for people outside
  the workspace. Only the request flood brake applies.
- **People outside the workspace** (invited people and public visitors,
  signed in or not) share one Site limit, **$10 a month** by default (or a
  daily amount instead), and an optional per-person limit (per day or per
  month, off by default). Admins can switch the agent off for them
  altogether (**Agent for people outside the workspace**).
- **Anonymous guests** also meet bot guards that are not shown on the
  Publish page: 20 conversations per visitor per day, 500 per Site per day,
  50 messages per conversation and $1.00 per conversation.

Each running turn reserves an estimate
(`OPENGENI_SITES_AGENT_RESERVATION_MICROS_PER_TURN`, $0.25 by default,
capped by the conversation cap and what is left) against the person's day
or month and the Site's day or month in one transaction, so visitors who
keep changing their visitor id or address can't spend past the Site's
limit, while a few open conversations don't use up the whole Site.
Reservations are settled to actual spend and released as turns and
conversations finish. When only other conversations' outstanding
reservations stand in the way, a start or message answers a retryable 429
`site_budget_busy` with `retryAfterSeconds`. Guests are also
rate limited per client address (four visitors' worth), so new visitor ids
don't reset their limits. A refused start or message answers 429
`site_budget_exhausted` with the `budget` that ran out
(`agent_micros_per_site_per_month`, `agent_micros_per_site_per_day`,
`agent_micros_per_visitor_per_day`, `agent_micros_per_visitor_per_month`,
`conversations_per_visitor_per_day`, `conversations_per_site_per_day`,
`turns_per_conversation`).

| Profile     | What it means                                                              |
| ----------- | -------------------------------------------------------------------------- |
| `standard`  | The defaults above (`DEFAULT_SITE_LIMITS`)                                  |
| `free`      | Former name of `standard`; accepted, stored and reported as `standard`     |
| `credits`   | The standard limits times `OPENGENI_SITES_CREDITS_LIMIT_MULTIPLIER`        |
| `unlimited` | No spend limits, but flood brakes and the per-conversation cap still apply |
| `custom`    | Your own numbers; missing fields take the standard defaults                |

Even unlimited keeps 600 requests per visitor per minute, 10,000
conversations per Site per day and $5.00 per conversation; signed-in people
outside the workspace meet the same two conversation caps. Workspace admins
set the limits and the default profile for new publications; each Site can
override it. Any profile may carry overrides that adjust its limits: the
Publish page edits the Site limit and the per-person limit this way and
keeps the profile's kind. The Publish page
shows the Site limit, the optional per-person limit and this period's spend
by people outside the workspace (for example "$1.20 of $10 used this
month") for invited and public Sites only.

Existing Sites take the new defaults without being republished. Limits are
resolved on every request from the stored profile, and migration 0789
rewrites stored profiles still on the old defaults:

- `free` becomes `standard` (a $10 monthly Site limit, no per-person limit,
  the guest bot guards above). Rows that old API processes still write as
  `free` during the rollout are read as `standard`.
- In `custom` overrides, every field equal to the old free default is
  removed (120 requests per visitor per minute, 30 guest writes per minute,
  agents and guest agents on, 10 conversations per visitor and 50 per Site
  per day, 20 messages and $0.02 per conversation, $0.20 per visitor per
  day, $2 per Site per month, no model list). A custom profile left with
  nothing becomes `standard`, so an old $0.02 cap or $0.20 per-person limit
  never carries over.
- Explicit values different from those old defaults are kept with their new meaning: a
  per-visitor daily amount is the per-person limit, the Site's monthly
  amount is the Site limit, and the conversation, message and
  per-conversation caps are guest bot guards.
- Overrides stored on other kinds are cleared; `credits` and `unlimited`
  are kept.

An intentionally chosen value exactly equal to an old default is indistinguishable
in stored profiles and is removed by this one-time migration. New explicit sparse
custom overrides are preserved at request time.

Reading a stored custom profile that still has the full old form also drops
its old-default values, so a row the migration hasn't reached yet behaves
the same.

Migration 0788 also marks existing conversations as using the legacy two-window
reservation protocol. New starts explicitly use four windows; settlement and
release subtract only reservations actually held in those windows, including
old-pod writes during rollout. Legacy member conversations with budget key `*`
stay usable and lose their old Site cap on their next admission.
Their newly settled spend goes to member windows, while any old reservation
is released from the original windows without touching other conversations.

## Platform usage

Apart from agent spend, published Sites use the platform: requests served by
the gateway, Site SQL rows read and written, and storage (Site SQL and Site
Data). Opengeni meters them per workspace and UTC month, with a monthly
allowance included. The allowance and the Opengeni-wide brake below cover
only this platform usage, never model spend, which follows the limits in
[Limits and billing](#limits-and-billing):

| Meter        | Included every month | Price above it (default)  | Metered where                               |
| ------------ | -------------------- | ------------------------- | ------------------------------------------- |
| Requests     | 1,000,000            | $0.60 per million         | Gateway, in signed batches (cache hits too) |
| Rows read    | 10,000,000           | $0.002 per million        | Site SQL                                    |
| Rows written | 100,000              | $2.00 per million         | Site SQL                                    |
| Storage      | 1 GB                 | $0.40 per GB-month (peak) | Site SQL and Site Data                      |

Prices are twice Cloudflare's list prices (Workers requests $0.30 per
million; SQLite-backed storage $0.001 per million rows read, $1.00 per
million rows written, $0.20 per GB-month), so the allowance is worth about
$1.22 a month. The gateway counts requests per host in memory and reports
them every `PLATFORM_REPORT_INTERVAL_SECONDS` (10 by default) or after 1,000
requests to `POST /v1/site-runtime/platform/requests`, signed on the Sites
domain apex; each report id counts once, so retries never double count. It
never refuses a request because of usage, and counts can be lost when an
isolate is evicted (at most one interval's worth).

`OPENGENI_SITES_PLATFORM_BILLING_MODE` decides what happens with the usage:

- `usage_only` (default): metered and shown, never charged or refused.
- `shadow`: also records what credits mode would have charged.
- `credits`: usage above the allowance is charged to the organization's
  credits (at most one debit per cent of new usage). When a meter's
  allowance is used up and the workspace has no spendable credits, or
  `OPENGENI_SITES_PLATFORM_OVERAGE_ENABLED` is `false`, Site SQL calls, Site
  Data writes that add storage and new publications fail with 402
  `payment_required` and `details.code` `site_platform_quota_exhausted`
  (with the `meter`, `allowance`, `used` and `reason`); serving pages never
  stops.

Workspace settings > Usage shows each meter against its allowance and what
was charged (`GET /v1/workspaces/:workspaceId/site-platform-usage`).

**The platform brake.** Opengeni re-estimates the month's platform cost of
all workspaces together (at most every 30 seconds per API process, after
metered usage). At `OPENGENI_SITES_PLATFORM_ALERT_PERCENT` (80%) of
`OPENGENI_SITES_PLATFORM_MONTHLY_LIMIT_USD` ($1,000; `0` turns the automatic
brake off) it logs `site_platform_limit_alert` once a month; at the limit it
engages the brake and logs `site_platform_brake_engaged`. While engaged,
Site SQL writes, new publications and new versions of published Sites, and
public visitors' agent conversations (guests and signed-in people outside
the workspace) answer 503 with `details.code` `site_platform_brake_engaged`;
pages keep serving, reads keep working, and members and invited people keep
the agent. Operators review and lift it with
`bun scripts/operator/site-platform-brake.ts status|lift|engage --operator
<name> --reason "<why>"`. A lift holds for the rest of the UTC month (the
automatic brake doesn't engage again until the next month, or until an
operator engages it by hand). API processes cache the brake state for up to
15 seconds.

## Reports and takedown

Every published Site shows a small **Report** link. Reports go to the Site's
managers (the **Reports** section on the Publish page), who mark them handled
or dismiss them. Reports are rate limited per reporter, per client address
and per Site.

Reports and flagged content scans also reach the deployment operator:

- every one writes a structured `site_abuse_notice` log line;
- when `OPENGENI_SITES_ABUSE_EMAIL` is set and the deployment has managed
  email configured, that address gets an email (at most one per Site per
  hour);
- `bun scripts/operator/site-moderation-queue.ts` lists open reports and
  flagged scans across all workspaces. It needs the role that owns the
  Opengeni schema (the migrations credential, which reads across workspaces
  through owner-only policies and needs no `BYPASSRLS`), or a superuser or
  `BYPASSRLS` role. The application role is refused.

The abuse contact shown to visitors is `OPENGENI_SITES_ABUSE_EMAIL`, or
`abuse@<sites domain>` when unset.

The owner or a workspace admin can **take down** a Site at once with a
reason: the API stops serving it immediately, its viewers are signed out,
its running conversations are cancelled, the edge cache is purged and an
audit event is recorded. New page loads stop within a minute, and every edge
location shows the takedown notice within about two minutes (see
[the gateway's takedown latency](../apps/site-gateway/README.md#caching-and-takedown-latency)).
**Restore** brings it back; only a workspace admin restores an admin's
takedown. While a Site is taken down its hostname can't be changed. The
operator takes any Site down with `bun scripts/operator/site-takedown.ts` (by
hostname, label or `--site-id`); only the operator restores those, and the
hostname stays held for the platform even if the Site or its workspace is
deleted (`--release-hold` frees it). An optional content scanner (Google Web
Risk) checks new versions when a key is configured.

## Staging and self-hosting

Publishing is off until `OPENGENI_SITES_DOMAIN` is set; the console then
hides the Publish button. Staging uses its own registrable domain (never a
subdomain of production) and forces sign-in and noindex. The Sites domain
must be a registrable domain of its own: Opengeni refuses to start when
`OPENGENI_PUBLIC_BASE_URL` or `OPENGENI_WEB_BASE_URL` is on the Sites domain,
under it, or holds it. Nothing in the API
depends on Cloudflare: edge sync is a no-op without its settings and the
gateway falls back to the API for host lookups.

| Setting                                                    | Default             | Purpose                                              |
| ---------------------------------------------------------- | ------------------- | ---------------------------------------------------- |
| `OPENGENI_SITES_DOMAIN`                                    | unset (off)         | The Sites domain; publishing is off without it       |
| `OPENGENI_SITES_GATEWAY_SECRET` / `_PREVIOUS`              | unset               | HMAC secret shared with the gateway, and its rotation |
| `OPENGENI_SITES_PUBLIC_ENABLED`                            | `true`              | Allow `public` Sites                                 |
| `OPENGENI_SITES_PUBLIC_AGENTS_ENABLED`                     | `true`              | Allow embedded agents on public Sites                |
| `OPENGENI_SITES_LOGIN_ONLY`                                | `false` (staging on) | Require sign-in on every Site                        |
| `OPENGENI_SITES_FORCE_NOINDEX`                             | `false` (staging on) | Always send noindex                                  |
| `OPENGENI_SITES_ABUSE_EMAIL`                               | `abuse@<domain>`    | Abuse contact shown to visitors; operator notices     |
| `OPENGENI_SITES_GUEST_AGENT_HUMAN_CHECK`                   | `false`             | Require a human check before guest agent conversations |
| `OPENGENI_SITES_AGENT_MICROS_PER_SITE_PER_MONTH`           | `10000000` ($10)    | Standard Site limit for people outside the workspace |
| `OPENGENI_SITES_AGENT_MICROS_PER_PERSON_PER_DAY`           | unset (off)         | Standard per-person daily limit                      |
| `OPENGENI_SITES_GUEST_CONVERSATIONS_PER_VISITOR_PER_DAY`   | `20`                | Guest bot guard                                      |
| `OPENGENI_SITES_GUEST_CONVERSATIONS_PER_SITE_PER_DAY`      | `500`               | Guest bot guard                                      |
| `OPENGENI_SITES_GUEST_TURNS_PER_CONVERSATION`              | `50`                | Guest bot guard                                      |
| `OPENGENI_SITES_GUEST_AGENT_MICROS_PER_CONVERSATION`       | `1000000` ($1)      | Guest bot guard                                      |
| `OPENGENI_SITES_AGENT_RESERVATION_MICROS_PER_TURN`         | `250000` ($0.25)    | Held per running turn against the Site's spend limits |
| `OPENGENI_SITES_FREE_*`                                    | unset               | Deprecated; used only when the settings above are unset |
| `OPENGENI_SITES_PLATFORM_BILLING_MODE`                     | `usage_only`        | `usage_only`, `shadow` or `credits`                  |
| `OPENGENI_SITES_PLATFORM_OVERAGE_ENABLED`                  | `true`              | Credits mode charges usage above the allowance       |
| `OPENGENI_SITES_PLATFORM_ALLOWANCE_*`                      | see Platform usage  | `REQUESTS`, `SQL_ROWS_READ`, `SQL_ROWS_WRITTEN`, `STORAGE_BYTES` |
| `OPENGENI_SITES_PLATFORM_PRICE_MICROS_PER_*`               | see Platform usage  | `MILLION_REQUESTS`, `MILLION_SQL_ROWS_READ`, `MILLION_SQL_ROWS_WRITTEN`, `GB_MONTH` |
| `OPENGENI_SITES_PLATFORM_MONTHLY_LIMIT_USD`                | `1000`              | Opengeni-wide monthly limit for the brake (`0` off)  |
| `OPENGENI_SITES_PLATFORM_ALERT_PERCENT`                    | `80`                | Alert threshold                                      |
| `OPENGENI_SITES_HOSTNAME_HOLD_DAYS`                        | `30`                | How long a released name stays held                  |
| `OPENGENI_SITES_CLOUDFLARE_*`                              | unset               | Optional edge sync (KV host map, cache purge)        |
| `OPENGENI_SITES_CLOUDFLARE_STORAGE_ENABLED`                | `false`             | Offer Site SQL (per-Site Durable Object databases)   |
| `OPENGENI_SITES_GATEWAY_INTERNAL_ORIGIN`                   | unset               | Gateway origin the API calls for Site SQL            |
| `OPENGENI_SITES_SQL_*`                                     | see Site SQL        | Site SQL limits                                      |
| `OPENGENI_SITES_WEB_RISK_API_KEY`                          | unset               | Optional content scanner                             |

The gateway Worker is configured with Wrangler: `SITES_DOMAIN`,
`API_ORIGIN`, `APP_ORIGIN`, `GATEWAY_SECRET`, `ENVIRONMENT`,
`FORCE_NOINDEX`, `LOGIN_ONLY`, `ABUSE_EMAIL`, optional Turnstile keys, and
the `HOST_MAP` (KV) and `RATE_LIMITER` bindings, plus
`PLATFORM_REPORT_INTERVAL_SECONDS` (1 to 25, default 10) for request
counting.

## Management API

All routes are under `/v1/workspaces/:workspaceId` and need a manager of the
Site unless noted. The SDK methods are on `OpenGeniClient`.

| Route                                                        | SDK method               |
| ------------------------------------------------------------ | ------------------------ |
| `GET /published-artifacts/:siteId/publication`               | `getSitePublication`     |
| `PUT /published-artifacts/:siteId/publication`               | `updateSitePublication`  |
| `DELETE /published-artifacts/:siteId/publication`            | `unpublishSite`          |
| `GET /site-hostnames/:label`                                 | `checkSiteHostname`      |
| `POST /published-artifacts/:siteId/publication/takedown`     | `takeDownSite`           |
| `POST /published-artifacts/:siteId/publication/restore`      | `restoreSite`            |
| `GET /published-artifacts/:siteId/publication/reports`       | `listSiteAbuseReports`   |
| `PATCH /published-artifacts/:siteId/publication/reports/:id` | `updateSiteAbuseReport`  |
| `GET`/`PUT /site-limit-profile` (workspace admins)           | `getSiteLimitProfile` / `updateSiteLimitProfile` |
| `POST /published-artifacts/:siteId/publication/fixes`        | `applySitePublicationFix` |
| `GET /site-platform-usage` (anyone in the workspace)         | `getSitePlatformUsage`   |
| `POST /v1/site-auth/authorize` (any signed-in person)        | `authorizeSiteViewer`    |

`GET` returns 404 for a Site that was never published, `PUT` returns 409
`site_hostname_taken` when another Site holds the name, 402
`site_platform_quota_exhausted` or 503 `site_platform_brake_engaged` for a
new publication (see Platform usage), 403 for an Only me
Site or a caller who can't manage it, and every route returns 503
`sites_publishing_disabled` when the deployment has no Sites domain.

```ts
const check = await client.checkSiteHostname(workspaceId, "team-crm-4k9x");
if (check.available) {
  const publication = await client.updateSitePublication(workspaceId, siteId, {
    label: "team-crm-4k9x",
    access: "public",
    agent: { enabled: true, model: "gpt-6" },
    // Admins only: people outside the workspace share $20 a month, $1 a day each.
    limitProfile: {
      kind: "custom",
      overrides: { agentMicrosPerSitePerMonth: 20_000_000, agentMicrosPerVisitorPerDay: 1_000_000 },
    },
    status: "active",
  });
  console.log(publication.url);
}
```

## Security notes for Site authors

- A published Site is a public web page: never put secrets, keys or private
  data in its HTML. Everything the page needs at runtime comes through the
  SDK, which the API authorizes per viewer.
- Viewer names, emails, Site Data records and agent replies are written by
  other people. Set them with `textContent`, never `innerHTML`.
- Site code reaches only the Site operation allowlist (`SITE_OPERATIONS`);
  it can't call the general workspace API, even for a member.
- Invited access matches the viewer's verified email. On deployments
  without managed sign-in an Opengeni user may have no email, so they can
  only reach `members` or `public` Sites.
