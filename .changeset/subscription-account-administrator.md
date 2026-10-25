---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Account administrators without an organization membership (a deployment's configured access key, an account-scoped key or a signed delegation with `account:admin`) administer the organization's subscription accounts again: connect, reconnect, rename, settings, access and disconnect for Codex, SuperGrok and Claude, in the API and on Organization > Models. Migrations 0956 (rolling) and 0957 let the API record its verified `account:admin` proof for one transaction, which the organization-administrator check accepts for that subject and account only. A workspace owner key can also remove its own workspace's account.
