---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Account administrators without an organization membership (a deployment's configured access key, an account-scoped key or a signed delegation with `account:admin`) can administer the organization's subscription accounts again: connect, reconnect, rename, settings, access and disconnect for Codex, SuperGrok and Claude, in the API and on Organization > Models. Migrations 0956 (rolling) and 0957 let the API record its verified `account:admin` proof for one transaction, and the organization-administrator check accepts it for that subject and account only. The recording routine is created without runtime EXECUTE. A follow-up release grants it, as with any new runtime definer, and that is when the database starts honouring the proof. A workspace owner key can also remove its own workspace's account, starting with this release.
