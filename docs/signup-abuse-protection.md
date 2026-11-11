# Signup and promotional-credit abuse protection

These controls separate human signup verification from eligibility for free funding.
They do not classify every automated user as abusive: legitimate agents, paid
funding, and customer model credentials retain their existing authority.

## Signup challenge

The managed browser signup boundary supports Cloudflare Turnstile. Enable it with
`OPENGENI_SIGNUP_CHALLENGE_ENABLED=true`, a site key, a secret key, and explicit
comma-separated `OPENGENI_SIGNUP_CHALLENGE_HOSTNAMES`. The stock console receives
only the public site key. Test keys are rejected outside local/test environments.
Self-hosted installations default to disabled. Managed deployment artifact generation
preserves all four settings in the private runtime Secret and reports missing
keys/hostnames when enabled; the secret key never enters generated Helm values.

`apps/api/src/auth/signup-challenge.ts` verifies tokens with Siteverify before
password hashing or new-user creation. The response must match the `signup`
action, an exact configured hostname, and a fresh timestamp. Verification has a
five-second timeout and fails closed. Cloudflare enforces single use. Neither
client-supplied verification flags nor a direct Better Auth API call bypass the
user-create backstop.

OAuth signup carries the successful challenge through server-owned login state,
bound to its provider and an expiry. Continue with Google or GitHub signs in or
creates the account from either tab and from the add-account window, so every
click first runs the challenge invisibly (`execution: "execute"`,
`appearance: "interaction-only"`); the widget appears inline only when Cloudflare
asks for interaction, and the login continues once it is solved. The click skips
the challenge while new accounts are paused. A social start whose token fails
verification, or a click whose challenge fails, still starts the login without
proof: an existing user signs in, and a new user is refused at the callback with
`signup_challenge_required`. Consuming a token on an existing-user sign-in is
harmless: it was minted for that click, and the proof only matters when the
callback creates a user. Email sign-up keeps its visible widget; email sign-in
needs none. This is distinct from organization invitations.

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

## Signup network velocity

`1354_signup_network_velocity.sql` adds a second rule for farms that never connect
a machine: many new self-serve organizations from one network. A real company
normally has one person set up an organization and invite colleagues, so several
new organizations from one address in a day are unusual. Observed farms reached 12
new organizations per hour and 21 per day from one address; real groups sharing an
address were at most three or four organizations.

**Record.** A new self-serve owner is a `self_service_organization_setup_receipts`
row, created by `POST /v1/auth/organization-onboarding`. When that receipt is
written, the existing setup trigger records one
`opengeni_private.signup_network_sources` row: the account, the owner user, the
setup time and two keyed hashes. The API derives the HMAC key from the existing
Better Auth secret (no new secret) and hashes the trusted client and its /24
(IPv4) or /48 (IPv6) prefix. The client is the IPv4 address or the IPv6 /64, the
same unit the request rate limiter uses, because one client normally controls a
whole /64; an IPv4-mapped IPv6 address counts as IPv4. Raw addresses are never
stored. Recording happens in every mode, so counts exist
before the rule is switched on. When the trusted client address is unknown
nothing is recorded, so unknown sources never group. Recording is best-effort and
never fails organization setup. Invited members never get a setup receipt, so
they are never recorded, counted or held. Rotating the Better Auth secret starts
new groups. Records older than 90 days are deleted a few at a time as new ones
arrive, except for accounts that are still held.

**Settings.** Owner-only and revision-fenced like the signup cutoff: every write
names the expected revision (0 before the first write, `40001` when stale) and
appends a row with the operator, reason and database role to
`opengeni_private.signup_network_velocity_revisions`. Runtime roles can neither
read the settings, sources or evidence nor write them.

| Setting | Default | Why |
| --- | --- | --- |
| `mode` | `off` | `observe` records evidence, `enforce` also holds. Migrations stay inert. |
| `windowHours` | 24 | Farms create 21 accounts per day from one address. |
| `exactHoldThreshold` | 3 | Hold from the 3rd new organization from one address (IPv6: one /64) within the window. Catches farms early; the largest real groups were 3-4, so release must be quick. |
| `prefixHoldThreshold` | none | /24 and /48 groups are a weaker signal (shared ISPs, offices, mobile carriers): recorded and shown in evidence, but they hold only if an operator sets a threshold. |
| `rateLimitEnabled` | off | Refuse extreme bursts at the organization step. |
| `rateLimitMax` | 5 | Per exact address per rolling hour; the 6th is refused. Far above any real pattern, well below the 12/h farms. |

**Detect and hold.** `free_plan_credit_eligible` (before Free issuance and in
spendable-balance admission) evaluates the current account only, under its own
account lock. For an account set up within the last seven days it counts distinct
self-serve organizations with the same address hash set up within the window of
this account's setup (including itself), and the same for the prefix. An
unexpected failure of this rule is logged and skipped, so it never blocks
admission or Free issuance. In
`observe` or `enforce` it records an observation with policy version
`ip-velocity-v1` when a group has two or more members: group sizes, thresholds,
the rule id, a short group reference and up to 20 setup times. Evidence has no
address or email. In `enforce`, when the exact count reaches the threshold, it
holds the account as `service:promotion-detector`. It never overwrites a manual
decision and never re-holds an account an operator released. The rule does not
wait for Free credit to be consumed. Groups are read with a bound of 501; a
larger group still meets any threshold.

After a new setup commits, the API also evaluates the other recent same-address
organizations, sequentially and each in its own account transaction, so reserve
farm accounts are held before they spend and appear for review. Failures are
logged and never fail setup; the per-account evaluation remains the backstop.

Holds use the existing promotion decision: sign-in, the app, invited members,
purchased credit, top-ups and paid-plan allowances are untouched, and the console
shows the existing held-credit notice with **Request review**. Holds withhold
funding only while funding enforcement (`--enforcement on`) is on.

**Rate limit.** With the rate limit on, organization setup from an address that
already has `rateLimitMax` new self-serve organizations in the last hour is
refused before anything is created, with HTTP 429 and the message "Too many new
organizations were created from your network in the last hour. Please try again
later, or ask a teammate to invite you to their organization." Refusing at the
organization step, not at user creation, means existing users and invited members
are never affected: the account can still sign in and accept invitations. An
idempotent replay of a committed setup is never refused. If the settings or the
count cannot be read, setup proceeds (fail open) and a warning is logged.

### Operator commands

All commands print JSON. Network groups appear only as 16-hex references of the
keyed hash; emails appear only as domains.

```sh
# Current settings and revision
bun scripts/operator/promotion-decisions.ts --network-velocity
# Observe first, then enforce (only the flags given change)
bun scripts/operator/promotion-decisions.ts --network-velocity-set --mode observe \
  --revision 0 --operator <operator-id> --reason 'Observe signup network velocity'
bun scripts/operator/promotion-decisions.ts --network-velocity-set --mode enforce \
  --revision <current-revision> --operator <operator-id> --reason 'Hold same-network farms'
# Rate limit on (or off), optional maximum; thresholds and window
bun scripts/operator/promotion-decisions.ts --network-velocity-set --rate-limit on \
  --rate-limit-max 5 --revision <current-revision> --operator <operator-id> \
  --reason 'Refuse extreme same-network bursts'
bun scripts/operator/promotion-decisions.ts --network-velocity-set --exact-threshold 3 \
  --window-hours 24 --prefix-threshold none --revision <current-revision> \
  --operator <operator-id> --reason 'Reset thresholds to defaults'
# Review pending detector holds of this rule, per account and per network group
bun scripts/operator/promotion-decisions.ts --network-holds --limit 200
# Capture denied and held owners' sign-in networks again (safe to repeat)
bun scripts/operator/promotion-decisions.ts --network-capture-flagged
# Release or deny one account (existing revision-fenced decision path)
bun scripts/operator/promotion-decisions.ts --account <uuid> --decision eligible \
  --revision <current-revision> --operator <operator-id> --reason 'Normal app use'
bun scripts/operator/promotion-decisions.ts --account <uuid> --decision denied \
  --revision <current-revision> --operator <operator-id> --reason 'Same-network farm'
# Rollback: release every current detector hold of this rule (try --dry-run first)
bun scripts/operator/promotion-decisions.ts --network-release-holds --dry-run \
  --operator <operator-id> --reason 'Roll back network velocity holds'
bun scripts/operator/promotion-decisions.ts --network-release-holds \
  --operator <operator-id> --reason 'Roll back network velocity holds'
```

`--network-holds` lists, per held account: decision and revision, signup and
setup times, email domain, exact and prefix group sizes, chats and sessions,
direct model API spend versus in-app spend, Free credit granted and used, and the
current held balance; per group: recent organizations and held accounts. The same
operations are available through the opengeni-ops `promotion-decisions` workflow
(`network-velocity`, `network-velocity-set`, `network-holds`,
`network-release-holds`, and `decision` for single accounts). A dry run lists the
accounts and revisions it would release. Bulk release writes operator `eligible`
decisions, so the released accounts are not held again.

### Reviewer rules

These apply to people and to agent reviewers using the JSON output.

- Release (`eligible`) accounts with normal app use: chats or sessions in the
  product, not only direct model API calls.
- Deny clear farm groups: large same-address groups whose accounts have zero chats,
  spend only through the direct model API and use throwaway domains.
- Leave anything unclear held for a human.
- Always use the current revision and give a reason.
- Never act on prefix-only evidence.

### Rollback

Set `--mode off` to stop new observations and holds. Release existing detector
holds of this rule with `--network-release-holds`. Turn the rate limit off with
`--rate-limit off`. The migration is additive; recorded sources and history stay
for review.

## Denied network

`1361_signup_denied_network.sql` adds a third rule (`denied-network-v1`) for farms
that come back in small waves: a few accounts after a quiet period on an address
already used by denied accounts never reach the velocity threshold. It holds the
Free credit of a new self-serve owner whose exact network (IPv4 address or IPv6
/64) was used, in the 90 days up to their organization setup, by an account with
a `denied` decision or a currently `held` account, even when it is the only
signup from that network in the window. Real shared addresses (offices, carrier
NAT) exist, so it holds for review rather than denying.
Holds placed by this rule do not count as matches themselves, so a hold never
spreads from one shared network to the next; once an operator denies such an
account, its networks count.

**Networks compared.** Two sources, each exact network only; /24 and /48
prefixes never take part:

- Signup: the API's address hash of 1354 (`signup_network_sources`) of the new
  organization against those of denied or held accounts.
- Sign-in: the networks of the new owner's sessions against those of the owners
  of denied or held accounts. Better Auth already stores session addresses
  (`auth_sessions.ip_address`); the database reduces each to its exact network and
  keeps only an HMAC-SHA256 under a random per-schema key
  (`opengeni_private.signup_network_session_keys`) that runtime roles cannot read.
  The key is in the same database, so anyone with the database owner's access or
  a full dump could recover IPv4 addresses by trying every address; the hashes
  protect against runtime roles, logs and exports, not against the owner. Rows
  live in
  `opengeni_private.signup_network_owner_addresses` (account, keyed hash, first
  and last sign-in); they hold no address or email. A session's use is its
  creation (sign-in) time; refreshes do not extend it, since the stored address
  is the sign-in address.

The new owner's session networks are recorded at organization setup. When an
account becomes `denied` or `held`, the decision setter captures its owner's
session networks (newest 200 sessions in the last 90 days) and remembers the
owner (`opengeni_private.signup_network_flagged_owners`), so the networks
outlast the sessions. Sign-ins after the decision are captured when the capture
runs again (`--network-capture-flagged`). Setup itself only writes the new
account's own rows. The migration captures every
account already denied or held, account by account, including those decided
before 1354; a failure is a migration warning with counts, and
`--network-holds` reports `deniedNetworkCoverage` (denied or held accounts and
how many owners are captured). Re-run the capture at any time with
`--network-capture-flagged`. Only account owners are recorded: invited members
are never recorded, counted or held. Released (`eligible`) accounts stop
counting. Rows not used for 97 days are removed a few at a time.

**Setting.** `deniedNetworkMode` in the 1354 settings (same owner-only,
revision-fenced writes), default `off`, independent of the velocity `mode`:
`observe` records a `denied-network-v1` observation with the matched denied and
held account counts, how they matched (`signup`, `sign-in`), up to 20 matched
account UUIDs and the last use time; `enforce` also holds as
`service:promotion-detector`. Hold semantics are those of the velocity rule: the
current account only, evaluated after setup and lazily at Free issuance and
admission for seven days after setup; never over a manual decision or an operator
release; failures are logged and skipped (fail open); capture and recording never
fail setup. Sign-in, the app, purchased credit and paid allowances are unaffected
and the console shows the held-credit notice with **Request review**.

```sh
bun scripts/operator/promotion-decisions.ts --network-velocity-set --denied-network-mode observe \
  --revision <current-revision> --operator <operator-id> --reason 'Observe denied networks'
bun scripts/operator/promotion-decisions.ts --network-velocity-set --denied-network-mode enforce \
  --revision <current-revision> --operator <operator-id> --reason 'Hold signups from denied networks'
# Review: --network-holds lists both rules; denied-network holds carry
# reason "Network used in the last 90 days by a denied or currently held account"
# and a deniedNetwork evidence block.
bun scripts/operator/promotion-decisions.ts --network-holds --limit 200
# Rollback of this rule only
bun scripts/operator/promotion-decisions.ts --network-release-holds --rule denied-network-v1 \
  --dry-run --operator <operator-id> --reason 'Roll back denied network holds'
```

Reviewers apply the rules above. A denied-network hold whose matches are only
held accounts (no denied ones) or a single old sign-in deserves a closer look
before denial. Rollback: `--denied-network-mode off`, then release with
`--network-release-holds --rule denied-network-v1`. Without `--rule`,
`--network-release-holds` releases the holds of both network rules.

## Funding and review

`0981_promotion_funding_decisions.sql` adds account decisions: `eligible`,
`verification_required`, `held`, and `denied`. A separate enforcement switch defaults
off. While off, decisions are inert and customer balances report effective eligible
status. While on, non-eligible decisions prevent new Free monthly grants and remove
identifiable remaining free promotional funding from spendable balances. Gross
ledger history remains unchanged. Purchased credit and paid-plan allowances stay
usable. Already-dispatched usage settles against its original funding; a hold does
not manufacture a refund. Releasing a hold restores the remaining funds.

A hold blocks Free and promotional funding for accounts with no purchased credit
and no paid plan: admission counts only non-held funds, so those accounts are
refused. An account with purchased credit or a paid-plan allowance is treated as a
paying customer. Its usage passes admission, and settlement includes held funds, so
that usage may consume held Free credit. This is intentional.

Legacy unrestricted signup amounts that cannot be distinguished safely from paid
funds are left untouched. Scoped signup grants and identifiable legacy Free plan
period funding are covered. The billing UI shows available funds and free credit
on hold, with a support path; there is no automated appeal or phone/card verification
flow. `verification_required` is an operator-review status.

### Customer access and mistaken restrictions

Suspected promotional abuse restricts free funding, not the customer's ability to
sign in. Keep the canonical human identity active. Password and existing OAuth
sign-in, organization access, purchased funding and customer-owned model
credentials remain available under their ordinary permissions. The authenticated
console explains the review and provides a **Request review** link to the
deployment's configured support email, with the organization reference. The
notice must not expose private detection evidence or label the person a bot.
Review can restore eligibility with the revision-fenced operator command above.

Correlated signup names, browser strings, shared networks and free-credit usage
may justify investigation; they do not establish that every member of a cluster
is abusive. Preserve the distinction between suspicion and verified linked
claims. Prefer reversible review decisions over identity disable for credit
abuse. Canonical identity disable remains an authentication security control and
must not be bypassed globally to implement this customer experience.

For an emergency incident that previously disabled identities, restoring login
requires a separately reviewed transition. First deploy every funding reader,
enable enforcement and write the exact reviewed account decisions. Verify direct
model API admission as well as session admission before reactivating identities
through their lifecycle with fresh revision and scope checks. Keep revoked keys
and old sessions revoked. Review workspace controls independently; a workspace
pause is user-resumable and is not a funding restriction. Never use ledger expiry
or a customer-editable allowance as a substitute for an operator hold. A deliberate
earlier restoration of login accepts exposure to remaining previously issued
credit until enforcement is deployed; the global new-grant pause does not block
that existing balance.

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

## Free credit signup cutoff

`1119_free_credit_signup_cutoff.sql` adds an owner-only cutoff for **new** Free
monthly periods. While a cutoff is set, `free_plan_credit_eligible` and the Free
branch of the maintenance sweep also require the owner named by the signup
receipt (`source_id`, an `auth_users` row) to have been created at or after the
cutoff. Organization creation time does not count: an older user who creates a
new organization does not qualify. With no cutoff (no revision, or a `NULL`
cutoff) nothing changes.

The cutoff is meant to be the time the signup challenge became enforced, so that
only owners who passed it receive Free credit. Use the moment every API replica was
enforcing the challenge (rollout complete), not the merge time. That holds only
while the challenge stays enabled: if the signup challenge is ever disabled, a later
signup still passes the cutoff without having passed a CAPTCHA.

It never removes, expires or changes what an already-issued period can spend.
`getSpendableCreditBalance` calls `free_plan_credit_eligible` only for its abuse
detector side effect and ignores the result. Paid plans, top-ups, decisions and
enforcement are unaffected.

```sql
opengeni_private.set_free_credit_signup_cutoff(p_not_before timestamptz, p_operator text,
  p_reason text, p_expected_revision bigint) -> jsonb
```

The setter compares `p_expected_revision` with the current revision (0 before the
first write) and fails with `40001` when it changed. Every write appends a row to
`opengeni_private.free_credit_signup_cutoff_revisions` with the operator, reason
(6-1000 bytes) and database role. Runtime roles can neither read the table nor call
the setter.

```sh
bun scripts/operator/promotion-decisions.ts --free-credit-cutoff-history
bun scripts/operator/promotion-decisions.ts --free-credit-cutoff 2026-10-29T15:08:00Z \
  --revision 0 --operator <operator-id> --reason 'Free credit only for CAPTCHA-verified signups'
bun scripts/operator/promotion-decisions.ts --free-credit-cutoff none \
  --revision <current-revision> --operator <operator-id> --reason 'Remove the signup cutoff'
```

Order matters. Deploy the release containing 1119, **set the cutoff, then turn Free
credit back on** in the subscription catalog. Turning Free on first lets the sweep
fund every older eligible owner before the cutoff exists. Owners who signed up after
the cutoff while Free was off are funded on the next sweep once it is on.

Rollback: turn Free off in the catalog (`freeCredit=false`, `monthlyCreditMicros=0`)
to stop all new Free periods. It does not remove periods that were already issued.
Clearing the cutoff (`--free-credit-cutoff none`) is not a rollback: while Free is on,
it widens funding, and the next sweep pays every older eligible owner. Clear it only
as a deliberate decision to fund them, normally after turning Free off.

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
