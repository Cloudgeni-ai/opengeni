# Subscription billing UI

Depends on backend PR #4591 and `docs/subscription-plans.md`.

Use the console's Inter typography and semantic neutral palette: canvas white,
foreground #242424, muted #5f5f5f, border #dedede, primary wash #ebf2f0.
Keep the existing settings frame. A quiet current-plan summary leads into a
responsive four-column plan comparison; top-ups remain a separate section.
Only the recommended next plan gets a primary action. Short confirmations
explain immediate prorated upgrades versus period-end changes. No decorative
marketing treatment or invented payment state.

Plan availability comes from the enabled subscription catalog AND a non-null
billing balance plan. Prices, credit and seat limits come from the catalog,
never client constants. Preserve organization identity fences and stable retry
keys for checkout and plan changes.

`SubscriptionPlans` owns the small confirmation flow and is remounted by the
full organization admin identity. `useSubscriptionCatalog` treats 404 as
disabled, suppresses stale responses and offers retry for other failures.
The People directory projects the original seat-limit error into partial
invitation results; the form keeps unsuccessful addresses for retry.

The development-only `/dev/subscription-plans?plan=free` preview imports the
production controls. `plan=pro`, `plan=max` and `plan=seats` exercise other
states with sample API data. It never contacts Stripe. The web suite tests
retry identity, stale results, disabled/no-plan behavior, balance separation
and period-end versus immediate actions. Only private web files change, so
no published-package changeset is needed.

The backend does not project the destination of a scheduled downgrade into
the balance read. The UI confirms its returned effective date, but after a
reload the current plan stays visible until the change takes effect. Manage
billing remains available for pending changes and payment problems.
