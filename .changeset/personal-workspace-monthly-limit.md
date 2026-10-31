---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

An organization can now limit what each person spends from its credits in their own Personal workspace each month. Organization settings → Billing has a "Personal workspaces" section with a monthly limit per person, off by default. Through the API it is `personalWorkspaceMonthlyCredits` (USD micros, `null` for no limit) on `GET`/`PATCH /v1/organizations/:organizationId/privacy-settings`, next to the existing Personal workspaces switch, and the same owners, admins and administration-capable organization keys change it. Agents can't, even with full access, as with workspace budgets. Setting a limit needs `OPENGENI_USAGE_ALLOWANCES_ENABLED`; removing one doesn't.

The limit acts as the monthly budget of every Personal workspace that has no budget of its own: usage reads report it with `resetsAt` at the next calendar month (UTC), and work stops with the usual `allowance_exhausted` refusal once it is spent. It counts the month's spending so far, including before it was set. Work paid by the person's own model plans or keys spends no credits and never counts. The person sees the limit on their Usage page.
