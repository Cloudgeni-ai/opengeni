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
