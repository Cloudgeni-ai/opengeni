---
"@opengeni/sdk": major
"@opengeni/contracts": major
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Schedules use the owner's current connector accounts on every run instead of a saved snapshot. Saving a schedule no longer stores which accounts were connected at that moment, so a reconnected, renamed or newly added account is picked up by the next run, and an account that was removed is simply no longer used.

A person can still pin accounts on a schedule that starts its own session, with `pinnedAccounts` on create and update (`[]` unpins everything). A pin narrows only its own connector; every other connector keeps following the owner's current accounts. Agents, API keys and services cannot pin accounts (403). A schedule that posts into an existing chat has no pins: that chat supplies its connectors and the owner's current accounts.

When a pinned account can no longer be used, the run goes ahead without that connector and never substitutes another account; the run records it in `degradedAccounts`. Set `pinnedAccountsRequired: true` to skip the run instead.

Migration: `connectionAccounts` and `connectionAccountsFrozen` are removed from schedule requests and `ScheduledTask.agentConfig`, and `attachableAccounts` is removed from `ScheduledTaskPolicyDrift`. Requests that still send `connectionAccounts` for a schedule are rejected; send `pinnedAccounts` only for an account a person chose, or nothing to follow the owner's current accounts. A database migration turns every saved account snapshot into the default behaviour. Session and message `connectionAccounts` are unchanged.
