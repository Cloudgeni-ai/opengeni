# Browser product journeys

Optional browser analytics is consent-controlled and disabled by default.
`apps/web/src/lib/analytics.ts` owns provider initialization and identity;
`analytics-journey.ts` owns the content-free route projection. Runtime provider
configuration comes from `/v1/config/client`.

PostHog uses the authenticated internal user ID as `distinct_id`, and the
current routed workspace's account ID as the `account` group. Managed operators
can resolve these IDs using their private identity directory. The browser never
sends email or names. Do not put that directory in PostHog person properties.

| Event | Meaning |
| --- | --- |
| `login_completed` | Consented legacy email sign-in with a confirmed cookie session, or an initiated Google/GitHub sign-in followed by a freshly created cookie session. |
| `app_opened` | An identified browser page initialized. This includes returning with an existing cookie; it is not a new login. |
| `app_active` | Trusted click/key input in a visible document, at most once per minute per mounted app. Recent interaction, not proof the user remains online. |
| `$pageview` | Page/section/workspace/session navigation, including allowlisted settings query sections. |
| `navigation_clicked` | Same-origin link clicked, with destination page/section. |
| `product_clicked` | Button/menu/tab clicked; a closed action label is attached for model connection controls. No visible text or input values. |
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
PostHog funnels as the consented subset. `login_completed` currently covers the
legacy managed sign-in UI, not broker account-slot additions. Never count agent
continuations, session creation, or recent page events as successful logins or
current online users. Always state the product, environment, time zone, interval,
and event definition used.

For a manual browser check, run an isolated full dev stack with an empty-credit
workspace, then run `OPENGENI_ANALYTICS_E2E_URL=http://127.0.0.1:3000 bun
apps/web/test/validate-analytics-browser.ts`. The script intercepts telemetry
locally and verifies consent, navigation, foreground activity and the visible
credit notice against the real app. It requires the Vite development server and
is separate from the default CI browser fixtures.

## Client error beacon

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
