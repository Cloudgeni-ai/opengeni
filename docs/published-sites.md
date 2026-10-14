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
  workspace for 30 days.
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

## Embedded agents

When the embedded agent is on, visitors can start conversations with it from
the Site. Each conversation runs as the Site's own service principal with
narrow permissions, the publication's model, instructions and tools, and a
per-conversation spend cap. A visitor can list, read and continue only their
own conversations on that Site. Agents started from a Site can't create or
change schedules or automations. Public Sites can let guests chat too; the
limit profile and the deployment decide.

## Limits and billing

The organization pays for everything a published Site does, metered into the
credit ledger like Site Data. The edge only brakes floods; Opengeni enforces
the limit profile before every conversation and message.

| Profile     | What it means                                                              |
| ----------- | -------------------------------------------------------------------------- |
| `free`      | Strict defaults that keep a busy Site cheap                                 |
| `credits`   | Higher limits paid from the organization's credits                         |
| `unlimited` | No budgets, but flood brakes and the per-conversation cap still apply      |
| `custom`    | Your own numbers; missing fields take the free defaults                    |

Free defaults (`DEFAULT_FREE_SITE_LIMITS`): 120 requests per visitor per
minute, 30 guest data writes per minute, 10 conversations per visitor per
day, 20 messages per conversation, and agent spend of $0.02 per
conversation, $0.20 per visitor per day and $2.00 per Site per month. Even
unlimited keeps 600 requests per visitor per minute and $5.00 per
conversation. Workspace admins set the default profile for new
publications; each Site can override it. The Publish page shows this
month's agent spend against the monthly budget.

## Reports and takedown

Every published Site shows a small **Report** link. Reports go to the Site's
managers (the **Reports** section on the Publish page) and to the abuse
contact, `abuse@<sites domain>` by default. Managers mark reports handled or
dismiss them.

The owner or a workspace admin can **take down** a Site at once with a
reason: visitors see a takedown notice, the edge cache is purged and an
audit event is recorded. The Site's API calls stop immediately; new page
loads stop within a minute, and every edge location shows the takedown
notice within about two minutes (see
[the gateway's takedown latency](../apps/site-gateway/README.md#caching-and-takedown-latency)).
**Restore** brings it back. Platform admins can
take any Site down; only they can restore those. An optional content
scanner (Google Web Risk) checks new versions when a key is configured.

## Staging and self-hosting

Publishing is off until `OPENGENI_SITES_DOMAIN` is set; the console then
hides the Publish button. Staging uses its own registrable domain (never a
subdomain of production) and forces sign-in and noindex. Nothing in the API
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
| `OPENGENI_SITES_ABUSE_EMAIL`                               | `abuse@<domain>`    | Abuse contact shown on takedown pages                |
| `OPENGENI_SITES_FREE_*`                                    | see above           | Free profile defaults                                |
| `OPENGENI_SITES_HOSTNAME_HOLD_DAYS`                        | `30`                | How long a released name stays held                  |
| `OPENGENI_SITES_CLOUDFLARE_*`                              | unset               | Optional edge sync (KV host map, cache purge)        |
| `OPENGENI_SITES_WEB_RISK_API_KEY`                          | unset               | Optional content scanner                             |

The gateway Worker is configured with Wrangler: `SITES_DOMAIN`,
`API_ORIGIN`, `APP_ORIGIN`, `GATEWAY_SECRET`, `ENVIRONMENT`,
`FORCE_NOINDEX`, `LOGIN_ONLY`, `ABUSE_EMAIL`, optional Turnstile keys, and
the `HOST_MAP` (KV) and `RATE_LIMITER` bindings.

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
| `POST /v1/site-auth/authorize` (any signed-in person)        | `authorizeSiteViewer`    |

`GET` returns 404 for a Site that was never published, `PUT` returns 409
`site_hostname_taken` when another Site holds the name, 403 for an Only me
Site or a caller who can't manage it, and every route returns 503
`sites_publishing_disabled` when the deployment has no Sites domain.

```ts
const check = await client.checkSiteHostname(workspaceId, "team-crm-4k9x");
if (check.available) {
  const publication = await client.updateSitePublication(workspaceId, siteId, {
    label: "team-crm-4k9x",
    access: "public",
    agent: { enabled: true, model: "gpt-6" },
    limitProfile: { kind: "free", overrides: null },
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
