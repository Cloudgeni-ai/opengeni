---
"@opengeni/core": minor
---

Every create, edit or access refresh that changes a schedule's pinned accounts, `pinnedAccountsRequired` or connector choices now writes a `scheduled_task.account_choices_changed` audit event in the same transaction, with the acting subject, the caller's principal kind and each changed choice before and after. Only server and connection ids are recorded.
