# Browser product journeys

Optional browser analytics is consent-controlled and disabled by default.
`apps/web/src/lib/analytics.ts` owns provider initialization and identity;
`analytics-journey.ts` owns the content-free route projection. Runtime provider
configuration comes from `/v1/config/client`.

PostHog uses the authenticated internal user ID as `distinct_id`, and the
current routed workspace's account ID as the `account` group. Managed operators
can resolve these IDs using their private identity directory. The browser never
sends email or names. Do not put that directory in PostHog person properties.
`app_opened` and `login_completed` wait until the signed-in user's account has
loaded, so the group is set first and both events carry it. A user with no
account yet (before organization setup) still reports them, without a group,
once that lookup has finished.

| Event | Meaning |
| --- | --- |
| `signup_submitted` | The email sign-up request was accepted (`method: "email"`, `verification_required`). It is the submitted form, not a verified account; social sign-ups report `signup_completed` instead. |
| `workspace_created` | The person created an additional workspace (`account_id`, `workspace_id`, deduplicated by `$insert_id`). |
| `login_completed` | Consented legacy email sign-in with a confirmed cookie session, or an initiated Google/GitHub sign-in followed by a freshly created cookie session. Carries the `account` group when the user has an account. |
| `app_opened` | An identified browser page initialized. This includes returning with an existing cookie; it is not a new login. Carries the `account` group when the user has an account. |
| `app_active` | Trusted click/key input in a visible document, at most once per minute per mounted app. Recent interaction, not proof the user remains online. |
| `$pageview` | Page/section/workspace/session navigation, including allowlisted settings query sections. `page` is one of the closed values below. |
| `navigation_clicked` | Same-origin link clicked, with destination page/section, plus `action` when the link carries a control label. |
| `product_clicked` | Button/menu/tab clicked, with `control_kind`, plus `action` when the control carries a control label. No visible text or input values. |
| `credits_required_viewed` | The composer displays an empty-credit notice; an external connection may still provide a usable alternative. |
| `session_start_blocker_viewed` | The new-session composer currently has a known blocker, including no connected model. This is exposure, not a submitted attempt. Re-emitted after consent is granted. |
| `session_start_blocked` | A submit handler was invoked while a known blocker remained. A disabled Send button cannot produce this event. |
| `session_create_attempted` / `session_create_finished` | Browser create request and HTTP result, joined by `interaction_id`. |
| `session_command_attempted` / `session_command_finished` | Existing-session event submission or composer submission and HTTP result. Commands can include controls, not just human messages. |
| `model_connection_attempted` / `model_connection_finished` | Recognized provider connection mutation and its HTTP result; accepting an authorization request does not mean the provider is connected. |
| `model_connection_resolved` | The UI observed a connected/expired/denied provider authorization, or an unknown transport outcome. |
| `session_started` | A session was successfully created (existing compatibility event), not evidence that an agent turn ran. |
| `signup_completed` | A sign-up or social authorization completed. `method` is `email`, `google`, or `github`; `is_new_user` is `true` when the flow created the account. Email sign-ups report it when the verification link returns (`is_new_user: true`); a Google/GitHub authorization of an existing account reports `is_new_user: false`. Reopening a still-valid verification link repeats the event, so count unique persons with `is_new_user = true`, or use the server `sign_up` counter, rather than raw events. Social sign-ups through the isolated session-set Add window (`dual`/`broker` modes) do not report it; see below. |
| `email_verified` | The browser returned from a successful email verification link (`method: "email"`). Reopening an already-used link can repeat it; the server counter is authoritative. |
| `organization_setup_completed` | The self-service post-sign-in organization setup request was accepted. |
| `checkout_started` | A credit checkout session was created; the browser is about to leave for Stripe. |
| `checkout_completed` | The organization page confirmed a Stripe success return. The outcome is one-shot: the page drops `checkout` from the URL immediately, so a reload, back navigation, or bookmark does not repeat it. Credits post asynchronously by webhook; returns to other pages are not observed. |
| `first_turn_completed` | The first agent turn of a session this page created completed while its view was open. Carries the session, workspace, and account IDs only. |
| `checkout_cancelled` | The organization page confirmed a Stripe cancel return (`checkout=cancelled`). One-shot per return like `checkout_completed`: reported once per document, and the page drops `checkout` from the URL. |
| `integration_connect_started` / `integration_connect_finished` | One connect journey for an integration, capability, or model provider. See "Integration connect journey" below. |
| `turn_failure_viewed` / `turn_failure_action` | The failed-turn banner was shown, and the person's first next step. See "Failed-turn recovery" below. |
| `onboarding_step_viewed` / `onboarding_step_completed` / `onboarding_abandoned` | Post-sign-in onboarding steps. See "Onboarding steps" below. |

## Pages and control labels

`analytics-journey.ts` reports `page` from a closed list, and anything else as
`other`. Workspace pages are the first path segment after
`/workspaces/<id>/`: `sessions`, `agents`, `variable-sets`, `environments`,
`rigs`, `machines`, `insights`, `priority`, `plugins`, `capabilities`,
`schedules`, `documents`, `memory`, `state`, `artifacts`, `settings`,
`organization`, and `files`; a session page also carries `session_id`.
`environments`, `capabilities`, `agents` and `priority` are legacy redirects, so they appear only
when an old link or bookmark opens them. Pages outside a workspace are matched by
exact path and never carry an id: `home` (`/`, including the sign-in panel),
`session-link`, `identity-link`, `checkout-return` (`/billing`),
`integration-return` (`/integrations`), `device`, `personal-security`, and the
sign-in and setup pages `setup-account`, `account-auth` and `reset-password`.
The last three are public authentication routes where providers stay suspended,
so they appear only as a `navigation_clicked` destination, never as a
`$pageview`. A drift test fails when an app route has no page label.

`section` comes from the `section` or `view` query value when it is on the
closed list (settings, organization, plugins and workspace-state sections). A
second drift test fails when a workspace settings or organization section,
current or legacy, has no label.

Key controls carry `data-analytics-action`, and the click observer attaches it
as `action` only when it is one of the closed values in `analytics-actions.ts`:

| `action` | Control |
| --- | --- |
| `new_session` | New session links in the rail and folder rows |
| `send` | Composer send button (`@opengeni/react`) |
| `steer` | Steer buttons on queued prompts (`@opengeni/react`) |
| `pause` | Composer pause button (`@opengeni/react`) |
| `connect_integration` | First connect of an integration: OAuth, API key, or adding an MCP server |
| `create_schedule` | Create schedule (not Save changes) |
| `install_skill` | Install Skill (not Update Skill) |
| `invite_member` | Send invitation in organization People |
| `buy_credits` | Buy or add credits buttons and links |
| `connect_model` | Connect a model links |
| `connect_codex`, `connect_supergrok`, `connect_ai_gateway`, `connect_openrouter` | Provider connect controls in settings and onboarding |

Clicks are the only signal: pressing Enter to send or Cmd/Ctrl+Enter to steer
is not a click. Use `session_command_attempted` for message volume.

Finished requests distinguish accepted, unauthenticated, credits required,
forbidden, conflict, invalid request, rate limit, server error and unknown
outcome. No request/response bodies, authorization codes, provider error text,
prompts, credentials, or DOM text are inspected. HTTP acceptance is not proof of
first response: use the private session/turn event facts for agent execution.

PostHog autocapture and replay stay disabled. For consented visitors PostHog
runs with `save_campaign_params` and `save_referrer` enabled, so first-touch
campaign attribution reaches events and initial person properties. The outbound
projection keeps only closed-charset `utm_source|medium|campaign|content|term`
tokens (and their `$initial_` person variants) plus `$referring_domain` /
`$initial_referring_domain` host names. It still removes every URL, pathname,
title, full referrer, session-entry referral, and ad/click identifier (`gclid`,
`fbclid`, `msclkid`, `ttclid`, and the rest of PostHog's click-ID list),
including nested initial person properties; page context is explicit closed
vocabulary and UUIDs.

## Integration connect journey

`src/lib/integration-connect-analytics.ts` reports
`integration_connect_started{integration_class, method}` and
`integration_connect_finished{integration_class, method, outcome}`.

- `integration_class` reuses the closed provider classes of the server
  lifecycle facts, so browser funnels join `connection.created` and
  `model.connected` (`packages/contracts/src/product-lifecycle-facts.ts`; a test
  keeps the lists identical): `slack`, `github`, `gitlab`, `azure_devops`,
  `bitbucket`, `google`, `microsoft`, `linear`, `atlassian`, `notion`,
  `supabase`, `datadog`, `posthog`, `openai`, `x`, `other`, and the model classes
  `codex`, `supergrok`, `vercel_gateway`, `openrouter`, `anthropic`,
  `claude_subscription`. Domains and MCP hosts map like the server function
  (`mcp.linear.app` is `linear`); custom MCP servers, custom APIs, Fiken and
  Reddit are `other`.
- `method`: `oauth`, `api_key`, `device_code`, `app_install`, `custom`.
- `outcome`: `connected`, `denied` (the person or provider refused, for example
  `error=access_denied` or `reason=provider_denied` on return), `provider_error`,
  `cancelled` (the authorization popup was closed or the attempt cancelled),
  `abandoned`, `outcome_unknown`.

Covered flows: every Connect API dialog (`NativeConnectSetup`: Slack bot and
personal, GitHub App/Lens, Google Drive, Microsoft Outlook/OneDrive, Atlassian),
catalog OAuth, API-key, X/Reddit and Fiken actions (`performCapabilityAction`,
used by the Plugins page and the in-chat capability card), the Plugins page MCP
OAuth dialog, custom MCP servers and custom APIs, in-chat reconnect redirects,
personal GitHub sign-in, Codex and SuperGrok (workspace and organization),
Vercel AI Gateway, OpenRouter, Anthropic and Claude-subscription keys, Claude
subscription sign-in, organization model providers, and the onboarding model
step. The inline OAuth card in a session (`SessionMcpCapabilityCard`) is not
covered because it lives in `@opengeni/react`.

Redirect flows leave the page. When collection is allowed, the start writes a
closed marker (class, method, start time; never an id or URL) to
`sessionStorage` under `opengeni.analytics.integrationConnect`. The boot entry
snapshots the provider return parameters (`integration_oauth`, `social_oauth`,
`fiken`, `slack`, `google_drive`, `atlassian`, `github_personal_oauth`,
`github`) before route handlers strip them, and the outcome is reported once
analytics starts. `abandoned` is best effort: a setup dialog closed before an
outcome, a page left (`pagehide`) while a popup flow was pending, a device code
that expired, or a return to the app without outcome parameters within an hour
of a redirect that normally carries them. Exact-return Connect redirects
(personal GitHub, X/Reddit from the Plugins page) return without parameters and
report `outcome_unknown`. A back-forward-cache restore does not re-run boot and
is not observed.

## Failed-turn recovery

When the failed-turn banner is shown, `turn_failure_viewed{failure_class}` is
reported once per failure per document. `failure_class` is derived from the
recorded failure code and closed markers, never from failure text:
`credits_exhausted`, `provider_credentials`, `provider_billing`,
`provider_access`, `daily_limit`, `monthly_limit`, `provider_quota`,
`rate_limited`, `provider_error`, `model_unavailable`, `codex_account`,
`safety_refusal`, `sandbox`, `mcp`, `context_limit`, `connectivity`,
`pre_start`, `other`. The first next step is reported as
`turn_failure_action{failure_class, action}` with `action` one of `retry`,
`switch_model` (another model chosen in the composer), `buy_credits`,
`connect_model`, `new_session` (a labelled New session control),
`send_message` (a new message sent from the composer), or `left` (best effort:
the banner went away without an action, the page was closed, or the tab stayed
hidden for five minutes).

## Onboarding steps

The post-sign-in setup reports `onboarding_step_viewed{step, variant?}`,
`onboarding_step_completed{step, via}` and `onboarding_abandoned{last_step}`.
Steps: `organization_name` (via `created`), `invitation` (via `joined`), and
`model_access` (via `start_chatting`, `skipped`, `connected_model`, or
`checkout`; `variant` is `credits`, `included`, or `choose`). `invitation` and
`model_access` are final. `onboarding_abandoned` is best effort: the onboarding
view unmounted (sign out, another account) or the page was closed before a
final step completed. Each step is reported once per document.

## First-touch attribution without device storage

`apps/web/src/lib/signup-attribution.ts` reads `utm_source`, `utm_medium`,
`utm_campaign`, `utm_content`, and `ref` from the landing URL before the router
starts and keeps valid values in page memory only. A valid value is a slug token
of at most 100 characters from `A-Z a-z 0-9 . _ ~ + -`; anything with a space,
`@`, `:`, `/`, `?`, `=`, or `%` (free text, email addresses, URLs) is dropped. Nothing is written to cookies or browser storage before consent.
The values travel with the sign-up itself:

- Email sign-up sends them as `opengeniAttribution` in the Better Auth request
  body and puts them, plus the one-shot `auth_event=email_verified` marker, in
  the verification link's return URL.
- Google/GitHub sign-in sends them as Better Auth `additionalData` (kept in the
  server-side OAuth state) and in the return URLs; new accounts return with
  `auth_event=<provider>_signup`, existing ones with `auth_event=<provider>_signin`.
- In session-set `dual`/`broker` mode, social sign-in runs in the isolated
  `/account-auth` Add window. The opener carries its first-touch values into
  that window's URL, and the window sends them as the optional `attribution`
  field of the social transaction start, which the API stores as the same OAuth
  state `additionalData`. The server acquisition counter therefore keeps working
  in every mode. That window returns through the fixed `/account-auth` callback
  with no `auth_event` marker, so browser `signup_completed` is not reported
  for those social sign-ups; use the server counters for them.

The server normalizes the values into the `opengeni_signup_acquisition_total`
source label (`producthunt`, `website`, `direct`, `other`) and stores nothing per
user. In the browser, the `auth_event` marker is removed from the URL at boot
and reported once analytics collection is allowed; campaign tokens are
registered as first-wins PostHog super properties when PostHog starts for a
consented visitor. Marketing links use
`https://app.opengeni.ai/?mode=signup&utm_source=opengeni.ai&utm_medium=website&utm_campaign=<cta-slug>`.
Reo and GA4 remain suspended on query-bearing routes. Public authentication routes
suspend providers. Consent revocation and identity changes invalidate pending
request/provider results so another actor cannot inherit them.

Coverage limits must appear in reports: declined/missing consent, blockers,
network loss and browsers blocking telemetry make this a lower bound; historical
uncaptured clicks cannot be reconstructed. For sign-up volume, verification,
sign-in, organization setup, and acquisition source, use the consent-independent
server counters (`opengeni_auth_events_total`, `opengeni_organization_setup_total`,
`opengeni_signup_acquisition_total`, see `docs/deployment.md`) and treat
PostHog funnels as the consented subset. The server funnel reads
`sign_up` -> `email_verified` -> `sign_in` -> organization setup `created`: in
the default `legacy` session-set mode the first successful verification click
also signs the new user in and counts as their first `sign_in` (a reused link
counts neither again), so verified email users reach `sign_in` without a
separate password sign-in. `sign_in` counts sessions, returning sign-ins
included, not unique users. A mail link scanner that follows the verification
link first (for example a safe-links prefetcher) takes that automatic sign-in:
its unused session counts `email_verified` and `sign_in`, and the person's later
password sign-in counts another `sign_in`. In PostHog, the verification landing
(`email_verified` plus `signup_completed`) is the sign-in step for email
sign-ups and reports no `login_completed`, so an `email_verified` ->
`login_completed` funnel shows drop-off that the server `sign_in` counter does
not. `login_completed` currently covers the
legacy managed sign-in UI, not broker account-slot additions. Never count agent
continuations, session creation, or recent page events as successful logins or
current online users. Always state the product, environment, time zone, interval,
and event definition used.

For a manual browser check, run an isolated full dev stack with an empty-credit
workspace, then run `OPENGENI_ANALYTICS_E2E_URL=http://127.0.0.1:3000 bun
apps/web/test/validate-analytics-browser.ts`. The script intercepts telemetry
locally and verifies consent (including the consent count request), page labels
for the pages above, the `new_session` and `connect_model` action labels, the
labelled composer send button, foreground activity, the visible credit notice,
and that the public sign-in and setup pages send nothing, against the real app.
It requires the Vite development server and is separate from the default CI
browser fixtures. On a stack without billing, where the credit notice cannot
appear, set `OPENGENI_ANALYTICS_E2E_SKIP_CREDITS=1` to skip only the credit
notice and `connect_model` checks.

## Consent count

PostHog sees only people who allow analytics. To state how much it misses, the
banner reports each changed answer to `POST /v1/analytics-consent`
(`src/lib/analytics-consent.ts`), which increments
`opengeni_analytics_consent_total{decision="granted|denied"}`. This is
first-party operational telemetry like the error beacon below, not a provider:
the body is only the decision, the request uses `credentials: "omit"`, and it
is sent for `denied` too. Re-confirming the same answer from Account
preferences is not counted again. People who never answer the banner are not
counted, so compare PostHog's consented numbers with the server counters as
well. See `docs/application-observability.md`.

## Client error beacon and failure signals

Route render failures, uncaught window errors, unhandled promise rejections and
stale lazy-chunk loads are reported to `POST /v1/client-errors`
(`src/lib/client-error-reporting.ts`), which increments
`opengeni_client_errors_total{kind="route_error|unhandled_rejection|window_error|chunk_load"}`.
This is operational telemetry, separate from the consent-controlled providers
above: the body is only the closed `kind`, the matched route pattern (for example
`/workspaces/$workspaceId/sessions/$sessionId`, or `unknown`), and the bundle
revision. It never carries an error message, stack, concrete URL, identifier,
cookie or user content; the request uses `credentials: "omit"`, and the API
rejects any other field. The route is public so failures before sign-in are
counted too.

The browser suppresses a repeated kind and route for one minute and sends at
most ten reports per ten minutes; the API additionally bounds admission per kind
and per process. ResizeObserver loop notices, opaque cross-origin
`Script error.` events and `AbortError` rejections are not reported. Treat the
counter as a lower bound: blocked requests, closed tabs and both rate limits
drop reports. It is not exception capture; use the route pattern and revision in
the API's `Web client error reported` log line to locate a failing page and
release.

The same beacon carries closed failure and health signals
(`src/lib/client-signals.ts`, metrics in `docs/application-observability.md`):

- **Requests that never reached the server.** The console fetch boundary
  (`managedActorFetch` in `src/api.ts`) reports a key mutation that failed
  without an HTTP response as `request_failure{action, reason}`. `action` is
  classified from the method and path shape only (`create_session`,
  `send_message`, `steer_message`, `composer_submit`, `retry_turn`,
  `connect_integration`, `connect_model`, `checkout_start`); `reason` is
  `offline` (the browser reported no connectivity), `timeout` (the client's own
  deadline), or `network`. Cancellations (`AbortError`: navigation, account
  change, a superseded request) are never reported.
- **Live stream health.** `src/lib/stream-health.ts` watches the session event
  stream and the workspace live stream: `reconnect` when a live stream drops (at
  most once per stream per minute), `reconnect_exhausted` when it stops
  reconnecting, and `long_disconnect` after 30 seconds of visible time
  connecting or reconnecting (hidden time does not count). Each at most once
  per disconnection.
- **Web vitals.** After load, `src/lib/web-vitals-reporting.ts` is imported
  lazily with the `web-vitals` package, so neither is in the initial or
  direct-session bundle graph. LCP, INP, CLS and TTFB are reported once per
  document (timings in seconds) with `page`, the closed journey label of the
  page the document loaded on. Every document is sampled
  (`WEB_VITALS_SAMPLE_RATE = 1`); the API bounds admission.

Automated browsers (`navigator.webdriver`, for example CI acceptance runs)
report none of these signals, so test traffic never skews the series; the
error beacon itself is unchanged.

The browser suppresses a repeated request-failure or stream signal for 30
seconds and sends at most twenty per ten minutes. A beacon that cannot be
delivered (offline, or the request failed) is held in page memory (at most 20)
and retried once when the browser fires `online`; it is never retried twice.

`chunk_load` counts documents that failed to load a lazy module or stylesheet,
which after a deploy usually means the tab still references replaced hashed
assets. The signal is Vite's `vite:preloadError` event
(`installVitePreloadErrorReporting`), which fires before the recovery listener
in `vite-preload-recovery.ts` decides whether to reload, so it counts both tabs
that recover through the automatic one-time reload and tabs that cannot.
Browser-specific dynamic-import failures that reach a route boundary or a global
listener without that event are classified as `chunk_load` too. Each document
reports at most one `chunk_load` and nothing after it until it reloads: when
recovery cancels the event, Vite resolves the failed import to `undefined` and
the router fails with an ordinary `TypeError` while the reload is in flight,
and counting that as `route_error` would raise the route-error rate on every
deploy. `route_error` therefore excludes stale-chunk failures.

Every router match has a styled error boundary (`src/components/route-error.tsx`),
so a failing page keeps the workspace rail and offers Reload and Go home. Once a
document has observed a chunk-load failure, any route failure it shows is
presented as an update with Reload first, including the brief follow-on failure
while the recovery reload is in flight. The raw error text is shown only in
development builds.
