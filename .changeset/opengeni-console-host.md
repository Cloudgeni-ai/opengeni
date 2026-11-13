---
"@opengeni/config": minor
"@opengeni/api-router": minor
---

Opengeni Console can run as its own platform on a `console.*` or `*.console.*` host (console.opengeni.ai, staging.console.opengeni.ai). There, every page stays in Console: Console's own sign-in, Members, Usage and billing and the organization name inside Console, an account menu with Sign out, and no links into the app. Verification emails, invitation links, Google and GitHub sign-in returns and Stripe returns open on the allowed host the request came from (`OPENGENI_BETTER_AUTH_ALLOWED_HOSTS`).

New optional `OPENGENI_BETTER_AUTH_COOKIE_PREFIX` renames the auth cookies (for example to keep staging apart from production on a shared parent domain). Unset keeps the current cookie names, so existing sessions stay signed in.
