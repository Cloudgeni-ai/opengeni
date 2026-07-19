<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# Organizations and identity design packet

Status: **revised after BLOCK/REQUEST CHANGES; implementation remains blocked pending fresh independent approval**

Issue: OPE-10

Date: 2026-07-19

This directory separates the design decision from implementation. No schema, API, SDK,
or UI change is authorized merely because these documents exist.

Read in this order:

1. [`tenancy-identity-adr.md`](tenancy-identity-adr.md) — domain model, invariants, roles,
   lifecycle semantics, and public contracts.
2. [`threat-model.md`](threat-model.md) — trust boundaries, abuse cases, required controls,
   revocation guarantees, and security verification.
3. [`migration-and-compatibility.md`](migration-and-compatibility.md) — additive schema shape,
   idempotent backfill, mixed-version behavior, and forward-only rollout gates.
4. [`ux-contract.md`](ux-contract.md) — account → organization → workspace switching,
   deep-link recovery, dirty-work guards, responsive behavior, and accessibility.

## Review gate

Before any schema change, one independent reviewer commissioned by the main orchestrator
must review this exact documentation tree and either:

- approve it with no unresolved high-severity finding; or
- request a new immutable documentation candidate that resolves every blocking finding.

Review must explicitly cover:

- identity linking and recovery;
- multi-account cookie and token isolation;
- invitation consumption and role escalation;
- last-human-owner concurrency;
- membership, session, stream, delegated-token, and API-key revocation;
- organization/workspace composite-key and FORCE-RLS invariants;
- billing/entitlement ownership separation;
- forward-only backfill and old-binary compatibility;
- embedded-host and self-hosted behavior; and
- destructive navigation with drafts or unresolved uploads.

An approval applies only to the reviewed commit and tree. Any semantic change to these
documents requires a fresh review.

The first exact-head review of commit `7b8aa79ea09dbfc92ee8cb0f9db5c87ce590bfab`
returned BLOCK/REQUEST CHANGES. This revision addresses that review but is not
self-approved. The Main Orchestrator must commission a fresh independent review of the
new immutable head.

## Blocked-review finding resolution index

| Finding | Normative resolution |
| --- | --- |
| S1.1 link/merge/recovery and personal-org conflicts | ADR §15 defines separate link, merge, and recovery state machines, proof/quorum, locks/revisions, cooling/dispute/reversal, deterministic conflict outcomes, effect ledger, and failure recovery; threat model T17 and UX §14 define adversarial tests and ceremony states. |
| S1.2 complete tenant/data-plane and actor-global isolation | ADR §§16–17 define canonical owners and enforcement for DB, object, NATS, search, cache, telemetry, jobs, callbacks/webhooks, provider connections, operators, and private state; threat model T18/T22 and §7.1 require two-tenant/two-actor negative tests. |
| S1.3 immutable audit authority | ADR §18 defines separate append-only privileges, explicit scopes, hash chains/external signed heads, integrity export, retention/legal hold, and lawful erasure; threat model T19 and migration §3.8 define enforcement and tests. |
| S1.4 mixed-version reauthorization | Migration §§7, 9, and 13–15 define phase authority, incompatible-binary drain, unforgeable versioned DB capability, synchronous canonical/legacy mutation, fail-closed disagreement, forward-only recovery, and old/new race proofs; threat model T20 covers attack behavior. |
| S2.5 enterprise federation | ADR §20 explicitly defers all domain/SCIM/SAML-organization/SSO lifecycle claims and fails closed; threat model T23 tests claim rejection. |
| S2.6 native/device sessions | ADR §19 defines common server session slots, secure-store/device binding, callback ownership, rotation/replay, loss/revocation, offline expiry, and push scoping; threat model T21 and UX §15 define tests and interactions. |
| S2.7 canonical private ownership | ADR §17 chooses typed human/login/slot/organization/workspace owners for drafts, pins, connections, keys, uploads, preferences, and caches and defines legacy subject migration; threat model T22 and UX §4 define same-human switch fencing. |
| S2.8 normalization and large-tenant migration | Migration §§12–15 define bytewise issuer/subject rules, verified-email and slug rules, tombstones, migration-number reservation, online DDL transaction limits, batch/lock/WAL/lag/CPU abort gates, and clean/upgrade/crash/scale tests. |
| S2.9 bootstrap and simplified mode | ADR §21 defines secure idempotent first-human/recovery bootstrap and collaboration transition; threat model T23 and UX §16 prohibit first-request ownership and define the simplified capability without weaker tenancy. |

## Ownership boundary

OPE-10 owns the generic human/login-account/organization/workspace model and its public
switching contract. It does not take ownership of:

- runtime database-role provisioning or RLS deployment posture;
- Codex subscription quota, eligibility, redemption, or reset-credit behavior;
- model/provider credential identity or turn-time billing attribution;
- Codex credential-pool allocation;
- lazy MCP capability policy;
- composer queue implementation;
- attachment/upload storage implementation; or
- release, deployment, rollback, or production verification.

Those systems consume the identifiers and invariants defined here but retain their
existing owners.
