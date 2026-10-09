# Codex subscription rotation (superseded)

Since maintenance migration `0683_subscription_core_codex_cutover.sql`, Codex
(ChatGPT subscription) accounts run on the shared subscription core. The legacy
selector, leases, refresh and failover path is unreachable and is deleted in M3
PR 4. Its historical text remains in git history.

| Topic | Now |
| --- | --- |
| Requirements | [Subscription accounts contract](subscription-accounts.md) |
| Placement, leases, refresh, waits, Apps and operations | [Subscription core design](design/subscription-core-2026-10-07.md) |
| Legacy migration and mapping | [Design, PR 3](design/subscription-core-2026-10-07.md#pr-3-the-drained-codex-cutover) |
| Deployment and fix-forward | [Deployment](deployment.md#codex-on-the-shared-subscription-core-0681) |
| Entry-point inventory | [Inventory](subscription-accounts-inventory.md) |

Legacy account ids remain aliases of their canonical connections; routes, SDK
methods and events retain their shapes (SUB-COMPAT-02).

## Included allowance and extra credits

Codex chat, compaction and chat-owned image generation check included allowance
immediately before each provider request in `agent-turn/codex-credit-policy.ts`,
independently of account selection. The default protects extra credits.
Exhausted response-header observations stop dispatch immediately; otherwise a
bounded `/wham/usage` read is required for each request. A successful check is
never reused for the next request. Weekly-only plans use their reported window,
without inventing a five-hour cap. Missing or unreadable allowance gives that
account a one-minute local admission hold, then re-places the checkpointed turn
or waits. It neither authorizes extra credits nor marks the account unhealthy.
Reported exhausted feature allowances also block spending conservatively;
provider feature identifiers have no authoritative model mapping yet.

Observed exhaustion is a local admission refusal, not a fabricated HTTP error.
Both allocators checkpoint durable progress before switching the same turn.
Manual pins, rotation policy and capacity waits still apply. Local observations
do not consume the provider-refusal budget. Resets are never redeemed automatically.
Each account's **Use extra credits** switch defaults off. Automatic routing
prefers included allowance across eligible accounts before opted-in credits,
including when a primary or warm account is exhausted. Manual pins and
primary-only selection follow that account's credit policy. A live consent and
accepted-pool check precedes credit dispatch, so revocation applies to the next
request. Real provider refusals still block the account. Pausing, reconnecting
and token refresh preserve consent.

This is request-boundary protection, not a provider-enforced monetary cap:
an individual request can cross a limit, provider reporting can lag, and
concurrent clients can consume allowance after a check. Voice and external-client
requests have their own admission paths.

Account usage details display the provider's extra-credit balance without
inventing a currency or converting missing data to zero. This balance is
separate from earned usage-limit resets. Organization administrators can inspect
live usage through `GET /v1/organizations/:organizationId/codex/accounts/:accountId/usage`,
including paused accounts and accounts assigned to no workspace. This read uses
organization administration authority, not a workspace's inference pool. It may
refresh the account's bearer under the existing credential lock and generation
fence, but does not alter routing quota, credit consent, or workspace access.
Usage is fetched when the account page opens and on manual refresh; failed reads
show the last saved quota and an unknown credit balance.

## Organization pause

Organization administrators can pause new chats and schedules without removing
the connection, workspace access, primary choice, health or running leases.
`PATCH /v1/organizations/:organizationId/codex/accounts/:accountId/allocator`
requires same-origin human administration and the current allocator version.
Same-state requests are idempotent; conflicting stale writes return 409. Legacy
changes and capacity wakes commit atomically; the core uses its canonical policy
mutation. Pause does not cancel an accepted running turn.

## Same-turn capacity recovery

No eligible capacity parks the same turn on `subscription_capacity_waiters`.
Workflow activity and signal names (`getCodexCapacityWait`,
`reconcileCodexCapacityWait`, `codexCapacityChanged`) remain stable. The reference
carries waiter id, generation, next check and wake revision, so pre-cutover
histories reconcile afterwards. Outbox-backed wakes re-place the accepted turn.
For a stalled waiter check `next_check_at`, `wake_revision`,
`observed_wake_revision`, and the organization's cutover row; see the
[wait design](design/subscription-core-2026-10-07.md#pr-2a-codex-chat-waits-wakes-re-placement-and-health-dormant).

## Historical maintenance cutovers

Databases older than 0683 still upgrade through 0403, 0422 and 0492. Each needs
drained processes and `OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES` listing
every old and new runtime login. Include retiring and replacement roles during
rotation; embedded callers pass the same list through
`MigrationRuntimeOptions.applicationDatabaseRoles`. Missing/malformed lists or
live listed sessions fail with SQLSTATE `55000` before changes.
