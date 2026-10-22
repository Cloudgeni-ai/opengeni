---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/subscriptions": minor
"@opengeni/react": patch
---

Every subscription account now has exactly one owner: the organization, one workspace, or one person, and it is used wherever it reaches and nowhere else. The per-workspace split between a workspace's own copy of an account and the organization's copy, the preference that chose between them, and "Set aside" are gone; each account has one on/off switch. A migration keeps everyone's access exactly as it was.

The organization's account lists now include `reach` (who each account reaches), and the organization's Models page lists every account once, grouped by provider, with its owner and a summary of how many are on and how many need reconnecting. Accounts that are turned off fold away when a provider has several, and the page no longer reads every workspace's accounts or each account's access one by one.
