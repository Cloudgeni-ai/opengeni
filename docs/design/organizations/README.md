<!-- docs-refs: record -->

> **Point-in-time design record.** Written against base commit
> `46744272e69f96329f47a0d3b1d6f93183d1d962`. Paths and names may move; code wins.

# Organizations and identity design packet

Status: **proposed; implementation blocked pending independent architecture and security review**

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