# Signup and promotional-credit abuse protection

These controls separate human signup verification from eligibility for free funding.
They do not classify every automated user as abusive: legitimate agents, paid
funding, and customer model credentials retain their existing authority.

## Signup challenge

The managed browser signup boundary supports Cloudflare Turnstile. Enable it with
`OPENGENI_SIGNUP_CHALLENGE_ENABLED=true`, a site key, a secret key, and explicit
comma-separated `OPENGENI_SIGNUP_CHALLENGE_HOSTNAMES`. The stock console receives
only the public site key. Test keys are rejected outside local/test environments.
Self-hosted installations default to disabled.

`apps/api/src/auth/signup-challenge.ts` verifies tokens with Siteverify before
password hashing or new-user creation. The response must match the `signup`
action, an exact configured hostname, and a fresh timestamp. Verification has a
five-second timeout and fails closed. Cloudflare enforces single use. Neither
client-supplied verification flags nor a direct Better Auth API call bypass the
user-create backstop.

OAuth signup carries the successful challenge through server-owned login state,
bound to its provider and an expiry. A new OAuth user chooses **Create a new
account** and completes the challenge; existing users continue normal login.
This is distinct from organization invitations and existing-user sign-in.

The browser must reach `https://challenges.cloudflare.com` for the widget and the
API must reach its Siteverify endpoint. A deployment CSP must allow the provider's
script and frame. Validate the actual managed domain and OAuth callback on staging
with deployment-owned keys before enabling production. Mocked verification tests
cannot establish a real provider configuration or browser network policy.

Cloudflare's [Free plan](https://developers.cloudflare.com/turnstile/plans/) offers
unlimited challenges and verifications. No paid fraud API or Enterprise device-ID
feature is required. Ordinary application compute, database, and email costs remain.

## Automatic detection

`0982_promotion_abuse_detection.sql` stores forward-only machine possession proof.
The API writes a proof only after verifying an Ed25519 renewal signature for the
exact enrollment credential generation. The Rust agent immediately performs that
signed renewal after enrollment. Merely submitting a public key, a project path,
an email domain, or prompt text is not proof and cannot trigger a hold.
Historical unverified enrollment keys are not backfilled as verified identities.

The first rule requires a shared proven key, at least three distinct verified
signup recipients whose organizations were created within 24 hours, and at least
two recipients having consumed 90% of a Free allowance. Expiry does not count as
consumption. Only recent organizations within seven days participate. Evidence is
bounded; oversized ambiguous cohorts are not automatically adjudicated. Matching
does not propagate transitively. Manual decisions always take precedence.

The existing `free_plan_credit_eligible` seam evaluates before free issuance and
spendable-balance admission. Detection modes are `off`, `observe`, and `enforce`.
Observe records evidence without changing decisions; enforce can hold only the
current account. This is a targeted free-credit farming rule, not a universal bot
classifier: new keys, no connected machine, slower rotation, and human CAPTCHA
solvers may evade it. Disposable-email, IP reputation, fingerprinting, and content
classification are not implemented by this change.

## Funding and review

`0981_promotion_funding_decisions.sql` adds account decisions: `eligible`,
`verification_required`, `held`, and `denied`. A separate enforcement switch defaults
off. While off, decisions are inert and customer balances report effective eligible
status. While on, non-eligible decisions prevent new Free monthly grants and remove
identifiable remaining free promotional funding from spendable balances. Gross
ledger history remains unchanged. Purchased credit and paid-plan allowances stay
usable. Already-dispatched usage settles against its original funding; a hold does
not manufacture a refund. Releasing a hold restores the remaining funds.

Legacy unrestricted signup amounts that cannot be distinguished safely from paid
funds are left untouched. Scoped signup grants and identifiable legacy Free plan
period funding are covered. The billing UI shows available funds and free credit
on hold, with a support path; there is no automated appeal or phone/card verification
flow. `verification_required` is an operator-review status.

Runtime roles can read their own minimal decision, not private evidence or other
accounts. Decision writers, policy switches, and history are owner-only. Decisions
use the same account credit lock as accounting and compare an expected revision,
so a stale review cannot overwrite a newer decision. History stores bounded
structured evidence and the operator/reason; it contains no raw prompts.

Use `scripts/operator/promotion-decisions.ts` with an owner URL in
`OPENGENI_MIGRATIONS_DATABASE_URL` and the configured database search path:

```sh
bun scripts/operator/promotion-decisions.ts --list
bun scripts/operator/promotion-decisions.ts --observations
bun scripts/operator/promotion-decisions.ts --show --account <uuid>
bun scripts/operator/promotion-decisions.ts --account <uuid> --decision held \
  --revision 0 --operator <operator-id> --reason 'Reviewed repeated free-credit claims'
bun scripts/operator/promotion-decisions.ts --account <uuid> --decision eligible \
  --revision <current-revision> --operator <operator-id> --reason 'Reviewed legitimate shared machine'
```

The bounded list includes free allowance totals and current held balance. Preserve
incident exports privately; do not commit customer identities or machine evidence.

## Rollout and rollback

Migrations are additive/rolling and default inert. Apply migrations and provision
roles normally. **Upgrade every API, control worker, and turn worker before enabling
funding enforcement:** older readers ignore holds. Keep the pinned previous-binary
readiness check green; it proves readiness compatibility, not funding behavior of
old binaries.

1. Configure and verify the challenge on staging with real keys and both email and
   OAuth signup. Confirm ordinary existing-user login and recovery still work.
2. Run detection in observe mode (`--detector-mode observe --operator <id>`), inspect private structured evidence, and manually
   adjudicate known incidents without treating old unverified keys as signed proof.
3. After all readers are upgraded, enable funding enforcement using the audited
   owner command, then enable automatic detector enforcement once observations are
   acceptable:

```sh
bun scripts/operator/promotion-decisions.ts --enforcement on --all-readers-upgraded \
  --operator <operator-id> --reason 'All funding readers upgraded and review complete'
bun scripts/operator/promotion-decisions.ts --detector-mode enforce \
  --operator <operator-id>
```

Disable the detector to stop automatic decisions. Disable funding enforcement to
restore the ordinary spendable projection without erasing evidence or decisions.
Disable the signup challenge independently if required. Do not roll back to an old
funding reader while enforcement remains on. Source merge is not deployment or
activation.

## Verification

Synthetic real-PostgreSQL tests exercise holds, paid-fund preservation, accounting
settlement, release, stale revisions, restricted runtime roles, tenant isolation,
mode separation, and the proven-machine rule. Auth integration tests exercise
email/OAuth verification and bypass attempts. UI tests exercise challenge reset and
held-credit display. Tests use mocks and synthetic accounts, with no paid model
calls or production mutations.
