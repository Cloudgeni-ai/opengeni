---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Add workspace and member usage allowances in integer USD micros, with
versioned configuration and member rules, operation-keyed credit grants,
current/historical usage reads, and a typed allowance-exhaustion error.
The session proxy exposes only the authenticated user's own usage read;
organization budget authority remains separate from workspace-admin member
splits, and agents cannot write allowance policy or grants.

Document per-seat equal splits, administrator sliders, custom shares,
top-ups, monthly team budgets, UTC month-end anchors, frozen causal usage
attribution, and model-call soft-ceiling semantics. Shares are oversubscribable
ceilings rather than reserved funds; admitted and concurrent calls may
overshoot before the next admission check.

Keep usage reads side-effect-free, retain active accounting windows across
period/anchor edits, and evaluate rollover, expiry, and usage notifications
through bounded periodic API maintenance. Preserve existing prepaid video
billing with exact, idempotent allowance-allocation reversal for matching
refunds.