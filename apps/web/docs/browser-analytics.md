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

Finished requests distinguish accepted, unauthenticated, credits required,
forbidden, conflict, invalid request, rate limit, server error and unknown
outcome. No request/response bodies, authorization codes, provider error text,
prompts, credentials, or DOM text are inspected. HTTP acceptance is not proof of
first response: use the private session/turn event facts for agent execution.

PostHog autocapture and replay stay disabled. The PostHog outbound projection
removes SDK-generated URL/title/referral/campaign properties, including nested
initial person properties; page context is explicit closed vocabulary and UUIDs.
Reo and GA4 remain suspended on query-bearing routes. Public authentication routes
suspend providers. Consent revocation and identity changes invalidate pending
request/provider results so another actor cannot inherit them.

Coverage limits must appear in reports: declined/missing consent, blockers,
network loss and browsers blocking telemetry make this a lower bound; historical
uncaptured clicks cannot be reconstructed. `login_completed` currently covers the
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
