<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# Organizations and identity design packet

Status: **corrective revision after a second exact-head BLOCK/REQUEST CHANGES; implementation remains blocked pending fresh independent approval**

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

- identity linking plus the separation/noninterference of deployment identity recovery,
  organization recovery, and deployment organization-governance custody;
- bounded merge staging/cutover, every post-apply write's provenance, containment,
  forward-only repair, and irreversible prerequisites/effects;
- multi-account cookie and token isolation;
- invitation consumption and role escalation;
- zero-resource active-team owner/recovery-steward custody across leave, removal,
  suspension, deletion, identity merge, and recovery races;
- membership, session, stream, delegated-token, and API-key revocation;
- organization/workspace composite-key and FORCE-RLS invariants;
- billing/entitlement ownership separation;
- forward-only backfill and old-binary compatibility;
- embedded-host and self-hosted behavior; and
- destructive navigation with drafts or unresolved uploads.

An approval applies only to the reviewed commit and tree. Any semantic change to these
documents requires a fresh review.

The first exact-head review, durable comment
`00832356-f44b-4c20-8c83-9e3103a6871d`, reviewed commit
`7b8aa79ea09dbfc92ee8cb0f9db5c87ce590bfab` and returned BLOCK/REQUEST CHANGES.
The second exact-head review, durable comment
`2528c3e1-2a52-44ef-b61a-6e2f61823284`, reviewed immutable commit
`4d8ce9ec2b66b3a386eb9c1fa350d1bcb88a0121` / tree
`b4f466b0417c0aefd99f34b904b103173fd7d6b6` and also returned BLOCK/REQUEST CHANGES.
That reviewed head remains blocked evidence. This correction addresses both reviews but
is not self-approved. The Main Orchestrator must commission one fresh independent
review pinned to the new immutable head after it is frozen.

## Blocked-review finding resolution index

| Finding | Normative resolution |
| --- | --- |
| S1.1 link/merge/recovery and personal-org conflicts | ADR §15 defines separate link, merge, deployment identity-recovery, and organization-governance-recovery state machines; bounded staging, provenance-backed containment/forward repair, deterministic conflict outcomes, and irreversible boundaries replace any lossless reversal promise. Threat model T17 and UX §14 define adversarial tests and exact ceremony states. |
| S1.2 complete tenant/data-plane and actor-global isolation | ADR §§16–17 define canonical owners and enforcement for DB, object, NATS, search, cache, telemetry, jobs, callbacks/webhooks, provider connections, operators, and private state; threat model T18/T22 and §7.1 require two-tenant/two-actor negative tests. |
| S1.3 immutable audit authority | ADR §18 defines separate append-only privileges, explicit scopes, hash chains/external signed heads, integrity export, retention/legal hold, and lawful erasure; threat model T19 and migration §3.8 define enforcement and tests. |
| S1.4 mixed-version reauthorization | Migration §§7, 9, and 13–15 define phase authority, incompatible-binary drain, unforgeable versioned DB capability, synchronous canonical/legacy mutation, fail-closed disagreement, forward-only recovery, and old/new race proofs; threat model T20 covers attack behavior. |
| S2.5 enterprise federation | ADR §20 explicitly defers all domain/SCIM/SAML-organization/SSO lifecycle claims and fails closed; threat model T23 tests claim rejection. |
| S2.6 native/device sessions | ADR §19 defines common server session slots, secure-store/device binding, callback ownership, rotation/replay, loss/revocation, offline expiry, and push scoping; threat model T21 and UX §15 define tests and interactions. |
| S2.7 canonical private ownership | ADR §17 chooses typed human/login/slot/organization/workspace owners for drafts, pins, connections, keys, uploads, preferences, and caches and defines legacy subject migration; threat model T22 and UX §4 define same-human switch fencing. |
| S2.8 normalization and large-tenant migration | Migration §§12–15 define bytewise issuer/subject rules, verified-email and slug rules, tombstones, migration-number reservation, online DDL transaction limits, batch/lock/WAL/lag/CPU abort gates, and clean/upgrade/crash/scale tests. |
| S2.9 bootstrap and simplified mode | ADR §21 defines secure idempotent first-human/recovery bootstrap and collaboration transition; threat model T23 and UX §16 prohibit first-request ownership and define the simplified capability without weaker tenancy. |

## Second exact-head review resolution index

| Finding | Coherent correction across the packet |
| --- | --- |
| S1. Deployment-wide recovery authority was derivable from one organization | ADR §§3, 15.4–15.5, and 16 separate deployment identity-recovery custodians/operations from active human organization recovery stewards/operations, with closed proof/quorum, delay, notice, audit, revocation, fail-closed, and organization-A/organization-B/personal noninterference. Threat model T14 and the invalidation/test matrices adversarially verify both directions. Migration §§3.9–3.10 and 4.5 require distinct persistence, database capabilities, and explicit enrollment. UX §§7 and 14 present two non-interchangeable recovery surfaces and warn when restored sign-in may make independently active grants usable. |
| S1. Thirty-day lossless merge reversal was not closed over later writes or irreversible prerequisites | ADR §§15.2–15.3 and 15.6 define a mutation barrier, at-most-500-row/250-ms invisible staging, short generation cutover, `applied_observation`/containment/repair states, transactional provenance for every affected post-apply write, scoped 14-day repair approvals, deterministic per-plane forward outcomes, and explicit irreversible facts. Threat model T17, migration §3.11 and §§14–15, and UX §14 cover concurrent writes, missing-provenance denial, repair exceptions, and user-visible retained/transferred/revoked/quarantined/compensated/irreversible outcomes. The 30 days are a dispute/containment window, never a reversal promise. |
| S2. An empty active team could lose its last accountable human | ADR §§4.6, 5.2, 9, and 15.2–15.5 guarantee at least one active human owner and one active human organization recovery steward regardless of resource count; invitations, non-humans, deployment identity-recovery custodians, and deployment organization-governance custodians never count. Last-capability mutations transfer atomically or fail, deletion retains custody through `deletion_pending`, suspension selects `governance_locked`, and merge activates canonical custody before deactivation. Threat model T7, migration §§3.3 and 4.5, and UX §§7–8 and 14 define serialized enforcement, delayed deployment custody, explicit deletion/transfer paths, and empty-team/race evidence. |

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
