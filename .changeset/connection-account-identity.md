---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/react": minor
"@opengeni/sdk": minor
---

More connections now know which account they belong to, so you can connect several accounts of the same service and connecting the same one again reuses it.

- **New identity checks.** Linear (its `get_user` "me" tool), Notion (the token's workspace and user, or `notion-get-self`), Asana (`get_me`) and Stripe (`get_stripe_account_info`) identify the signed-in account, and are labelled with its email, name or workspace. Any other service whose authorization server advertises OpenID Connect (for example PostHog, Zapier, Vercel, Mobbin, PagerDuty and Dropbox) is asked for `openid` and `email` with a nonce, and identified by a verified `id_token` or its userinfo endpoint. These scopes are never added where the server doesn't advertise them. Every check is bounded and never fails the connection.
- **One account per person for services that can't say.** When a service doesn't tell us which account you signed in with, each person sees at most one connection to it: a second one, a personal one beside a shared one, or a shared one beside your own is refused with "This service doesn't tell us which account you signed in with, so you can connect one account. Disconnect it to use a different one." (`account_limit_one`). Other people's personal connections never block yours. A connection made before its service could be identified must be reconnected once before another is added (`account_reconnect_required`).
- **Yours and Shared.** Connected accounts are labelled "Yours" or "Shared" (was "Only me" and "This workspace") in account lists, pickers and the composer's Connectors menu, and agents see `<connector> — <account> · Yours` or `· Shared`, so a personal and a shared connection never look the same.
- **API.** OAuth MCP connections in connection lists include `accountIdentity`: `verified`, `reconnect` or `single`. In `@opengeni/react`, `addAccountLimit` and `ADD_ACCOUNT_LIMIT_COPY` mirror the rule, and the connector page hides Add account with that sentence where the rule applies.
