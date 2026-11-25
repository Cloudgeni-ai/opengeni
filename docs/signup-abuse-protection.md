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
row, created by `POST /v1/auth/organization-onboarding` or the older first
organization route `POST /v1/organizations` (both write the same receipt and
both pass the signup network since `1471`). When that receipt is
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

| Setting               | Default | Why                                                                                                                                                                     |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                | `off`   | `observe` records evidence, `enforce` also holds. Migrations stay inert.                                                                                                |
| `windowHours`         | 24      | Farms create 21 accounts per day from one address.                                                                                                                      |
| `exactHoldThreshold`  | 3       | Hold from the 3rd new organization from one address (IPv6: one /64) within the window. Catches farms early; the largest real groups were 3-4, so release must be quick. |
| `prefixHoldThreshold` | none    | /24 and /48 groups are a weaker signal (shared ISPs, offices, mobile carriers): recorded and shown in evidence, but they hold only if an operator sets a threshold.     |
| `rateLimitEnabled`    | off     | Refuse extreme bursts at the organization step.                                                                                                                         |
| `rateLimitMax`        | 5       | Per exact address per rolling hour; the 6th is refused. Far above any real pattern, well below the 12/h farms.                                                          |

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

**Sign-in networks (`1471`).** The signup address alone misses setups whose
request carried no signup network (before `1471`, every `POST /v1/organizations`
setup) and farms that rotate the setup address. Since `1368` the database records
every new owner's sign-in networks (keyed hashes of `auth_sessions` addresses,
owners only), and `1471` can count them in the same rule: for each exact network
the owner signed in from within the window of the setup (newest 5), the new
self-serve organizations set up within the window whose owners signed in from that
network within the window of their own setup, including this one. This leg has
its own setting, `signInNetworkMode` (`off` until set, then `observe` or
`enforce`), because the threshold was tuned on one address per setup. In
`enforce`, when the largest group reaches `exactHoldThreshold`, it holds with rule
`ip-velocity-sign-in-v1`. Evidence adds `signInGroupSize`, `signInGroup` (a short
reference under the database key, never comparable with `addressGroup`),
`signInGroupSetupTimes` and `signInNetworkMode`. Before counting, the owner's newer
sign-ins are recorded, so a sign-in after setup counts too. An organization without
a signup network is evaluated from its recorded setup time (kept 15 days). "Within
the window" is the overlap of a network's first and last recorded sign-in with it,
an approximation. Loopback, unspecified, link-local, private and shared
(100.64/10) session addresses are never networks. While the leg is on, the setup
trigger also lists recent same-sign-in-network organizations (at most 51 in all)
for the after-commit evaluation. Every read is bounded (200 candidates per
network, 501 per group). The leg fails in its own block and never undoes the
signup network result; it is skipped when that already holds. Manual decisions
and releases are never overwritten, and prefixes still never hold on their own.

Incident (15 Nov 2026): 665 owners created organizations through
`POST /v1/organizations` from about 50 addresses in under four hours. That route
did not pass the signup network, so the rate limit and this rule never saw them,
and none was held.

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
sign-in group size and reference,
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
  `ip-velocity-sign-in-v1` groups are judged the same way.
- Leave anything unclear held for a human.
- Always use the current revision and give a reason.
- Never act on prefix-only evidence.

### Rollback

Set `--mode off` to stop new observations and holds (and
`--sign-in-network-mode off` for the sign-in leg). Release existing detector
holds of this rule with `--network-release-holds`. Turn the rate limit off with
`--rate-limit off`. The migration is additive; recorded sources and history stay
for review.

## Denied network

`1368_signup_denied_network.sql` adds a third rule (`denied-network-v1`) for farms
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

The new owner's session networks are recorded at organization setup, and again
at each evaluation while the setup can still be evaluated (seven days) when the
owner has signed in since (`1375_signup_denied_network_later_sign_ins.sql`).
Farms set up from a fresh address and sign in from their usual network a minute
later, so a sign-in after setup must count. The refresh is one indexed look-up
of the owner's newest sessions and writes only when a newer sign-in has a
network; if it fails, the evaluation still uses what is already recorded. The
signup network (the API's key) and the sign-in networks (the database's key)
use different keys, so they are never compared with each other. When an
account becomes `denied` or `held`, the decision setter captures its owner's
session networks (newest 200 sessions in the last 90 days) and remembers the
owner (`opengeni_private.signup_network_flagged_owners`), so the networks
outlast the sessions. Sign-ins after the decision are captured when the capture
runs again (`--network-capture-flagged`). Setup itself only writes the new
account's own rows. `1369_signup_denied_network_backfill.sql`, in its own
transaction so 1368's settings lock is not held meanwhile, captures every
account already denied or held, account by account, including those decided
before 1354; a failure is a migration warning with counts, and
`--network-holds` reports `deniedNetworkCoverage` (denied or held accounts, how
many owners are captured, how many have no self-serve owner to capture, and the
oldest capture). Re-run the capture with `--network-capture-flagged`, for
example daily while the rule is on, so that sign-ins after a decision are
included. Only account owners are recorded: invited members
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
# Sign-in network leg (migration 1471): observe first, then enforce
bun scripts/operator/promotion-decisions.ts --network-velocity-set --sign-in-network-mode observe \
  --revision <current-revision> --operator <operator-id> --reason 'Observe sign-in network velocity'
# Rollback of this rule only
bun scripts/operator/promotion-decisions.ts --network-release-holds --rule denied-network-v1 \
  --dry-run --operator <operator-id> --reason 'Roll back denied network holds'
```

Reviewers apply the rules above. A denied-network hold whose matches are only
held accounts (no denied ones) or a single old sign-in deserves a closer look
before denial. Rollback: `--denied-network-mode off`, then release with
`--network-release-holds --rule denied-network-v1`. Without `--rule`,
`--network-release-holds` releases the holds of every rule listed here.

## Email clusters

`1489_signup_email_cluster.sql` adds `email-cluster-v1` for farms that rotate
networks: many new organizations whose owners use one throwaway or alias-relay
mail domain, or setups scripted within the same seconds. Every new self-serve
organization (first ones and additional ones, 1484) records the class of its
owner's mail domain and, for a non-public domain, a keyed hash of it under the
1368 key (`opengeni_private.signup_owner_email_domains`; no address or domain is
stored; rows kept 45 days). Classes: `reserved` (`.test`, `.example`,
`.invalid`, `.localhost`, `.local`, `example.com/.net/.org`; never counted),
`public` (large mail providers such as Gmail, Outlook, iCloud, Yahoo, Proton,
Posteo or regional ISPs), `relay` (shared relays such as SimpleLogin, Firefox
Relay, DuckDuckGo or Apple's private relay, used by many unrelated people),
`personal_relay` (a per-person subdomain of addy.io, anonaddy or 33mail, or of a
dynamic DNS host such as DuckDNS, No-IP, Dynu or FreeDDNS; grouped on the full
subdomain, never on the shared parent), `academic` (`.edu`, `.ac.*`), `company` (any other
domain) and `unknown`.

Three legs, each with its own mode:

- Burst (`signup-burst-v1`, `burstMode`, `enforce`): `burstHoldThreshold` (4)
  organizations set up within `burstWindowSeconds` (10) through the same
  provider (a shared relay, a per-person relay service or a dynamic DNS host; a
  same-second batch through one is a farm), or with the same domain group and the
  same signup network. A burst that shares only a network, or only a company or
  academic domain (a workshop, classroom or office onboarding colleagues), and a
  burst of unrelated public or unknown domains are observed only.
- Denied domain (`email-denied-domain-v1`, `deniedDomainMode`, `enforce`):
  `deniedDomainHoldThreshold` (2) distinct denied organizations with the same
  company, academic or personal relay domain, set up in the
  `deniedDomainLookbackDays` (30) before this one; for a per-person relay or
  dynamic DNS name (one person) one denied organization is enough. Public
  providers and shared relays never propagate a denial, and an academic domain is observed only.
  Holds never propagate; only denials do.
- Domain (`email-domain-v1`, `emailDomainMode`, `observe`):
  `emailDomainHoldThreshold` (3) distinct owners with the same company or
  personal relay domain set up within `emailDomainWindowMinutes` (60). Observed
  by default, because a company or workshop can sign several colleagues up in an
  hour; shared relays and academic domains never group here.

The defaults come from hosted production's self-serve setups (60 to 90 days):
no legitimate company domain set up more than 2 organizations in an hour, every
domain with 3 or more in an hour was a throwaway farm, and outside one abuse
incident no 10 seconds saw more than 2 setups. Invited members never count.

**Setting.** `emailDomainMode`, `burstMode` and `deniedDomainMode` in the 1354
settings (`off`, `observe`, `enforce`), with the thresholds and windows above.
Evaluated
after setup (the setup lists this organization and its recent domain and burst
peers in `opengeni.signup_email_cluster_evaluate_accounts`, so the first
members of a burst are held too) and lazily at Free issuance and admission for
seven days after setup. Hold semantics are those of the other rules: current
account only, never over a manual decision or an operator release, fail open.
Evidence carries the domain class, a 16-hex domain group, group sizes and
settings; reviews show the owner's email domain as for the other rules.

```sh
bun scripts/operator/promotion-decisions.ts --network-velocity-set --burst-mode observe \
  --revision <current-revision> --operator <operator-id> --reason 'Observe signup bursts'
bun scripts/operator/promotion-decisions.ts --network-velocity-set --email-domain-mode enforce \
  --revision <current-revision> --operator <operator-id> --reason 'Hold same-domain farms'
bun scripts/operator/promotion-decisions.ts --network-velocity-set --email-domain-threshold 4 \
  --burst-threshold 5 --revision <current-revision> --operator <operator-id> --reason 'Loosen'
bun scripts/operator/promotion-decisions.ts --network-release-holds --rule email-cluster-v1 \
  --dry-run --operator <operator-id> --reason 'Roll back email cluster holds'
```

Rollback: `--burst-mode off --denied-domain-mode off` (and `--email-domain-mode
off`), then release with
`--network-release-holds --rule email-cluster-v1`.

### Disposable inboxes and slow domain groups

`1493_signup_disposable_mail.sql` adds two more legs to `email-cluster-v1`:

- Disposable mail (`disposable-mail-v1`, `disposableMailMode`, `enforce`): the
  owner's mail domain, or one of its MX hosts, is a temporary-inbox service.
  At setup (first and additional organizations) the API resolves the domain's
  MX, bounded by `OPENGENI_SIGNUP_MAIL_MX_LOOKUP_TIMEOUT_MS` (1500; 0 turns the
  lookup off), cached for an hour, and matches the domain and the MX hosts
  against a built-in list of temporary-inbox services
  (`apps/api/src/auth/signup-mail.ts`) plus
  `OPENGENI_SIGNUP_DISPOSABLE_MAIL_DOMAINS` (comma separated; a name matches
  itself and its subdomains). Only the flag reaches the database
  (`mail_signal`: `disposable` or `clear`); a slow or failed lookup records
  nothing (fail open). Anyone can read such an inbox, so the address proves no
  person; the list never names general mail hosts that real companies use, or
  forwarders that deliver to the person's own inbox.
- Slow domain (`email-slow-domain-v1`, `slowDomainMode`, `enforce`):
  `slowDomainHoldThreshold` (3) distinct owners on the same company or
  personal relay domain within `slowDomainWindowHours` (24), and none of those
  organizations ever admitted a model call. A farm signs owners up one a minute
  over hours and never uses them; once any colleague of a company has started
  working, its group is not held. Public providers, shared relays and academic
  domains never group here. Use is stamped once per organization
  (`first_admitted_at`) by a model-call admission; nothing reads other
  organizations' usage. The hold lifts itself: when a held colleague sends a
  model call, that admission stamps the use, finds the group used and
  releases its own slow hold (`email-slow-domain-released-v1`) before the
  eligibility check, so the call proceeds. Every other organization of the
  group releases the same way at its own next evaluation. Only a detector
  hold whose current rule is `email-slow-domain-v1` is released; manual
  decisions and holds from other rules are never touched.

Sizing (hosted production person lifecycle since June 2026, about 720
non-public owner domains): 3 or more owners on one non-public domain within 24
hours with no earlier use by any of them happened on 38 domains, all throwaway;
real company groups had used the product before their third owner signed up.
About 560 of those domains received mail at temporary-inbox MX hosts. How fast
an address is verified is not a signal: two thirds of all email signups verify
within 10 seconds.

```sh
bun scripts/operator/promotion-decisions.ts --network-velocity-set --slow-domain-mode observe \
  --revision <current-revision> --operator <operator-id> --reason 'Observe slow domain groups'
bun scripts/operator/promotion-decisions.ts --network-velocity-set --disposable-mail-mode off \
  --slow-domain-threshold 4 --slow-domain-window-hours 12 \
  --revision <current-revision> --operator <operator-id> --reason 'Loosen'
```

During the rollout, previous-release pods record no mail signal and stamp no
use, so a group whose members only used the product through them looks
unused. Rollback: `--disposable-mail-mode off --slow-domain-mode off`, then
release with `--network-release-holds --rule email-cluster-v1`.

### Rapid additional organizations

An unpaid person's second and later additional organizations created within 24
hours of their first organization start held (rule
`additional-organization-v1`, migration 1491). The first additional
organization is never held by this rule, and a person who owns or administers
any paying organization (paid plan, Enterprise, Stripe or a credit top-up) is
exempt. In the last 60 days every farm additional organization was created
within 24 hours, while the few real people who did so created only one. The
check fails open. Rollback: release with
`--network-release-holds --rule additional-organization-v1`.

A detector hold on an additional organization (this rule or any other signup
rule) restricts only that organization. It doesn't follow the person: their
other organizations aren't linked-restricted, and it doesn't trigger the
linked-owner hold on their next organization. A manual operator denial or
reviewer decision still follows the person as before.

## Card verification

Migration `1494_card_verification_gate.sql` adds a deployment-wide gate,
off until an operator turns it on. While it is on, an unpaid organization
(Free or plan-less, never bought credit, no Stripe subscription) needs a card
its owner verified before it:

- starts a sandbox box. Every box-start path goes through sandbox admission
  (agent turns, terminals and commands, background processes,
  Browser/ComputerSessions, viewers). A refusal has reason `card_required`
  and code `sandbox_card_required`: an agent turn fails with it (not
  retried), API surfaces answer 403 (viewers 429) with `details.code`. Joining
  a box that is already running, and a Connected Machine, are never refused.
- receives Free monthly credit (`free_plan_credit_eligible` and the
  subscription maintenance inventory).

Card trial: before the card, an agent turn may still start a box until the
organization has used its tier's `cardTrialBoxSeconds` of metered box time
over its whole life (`OPENGENI_SANDBOX_PLAN_LIMITS_JSON`; default 600 for
`free`, `new` and `none`, none for `restricted`; 0 turns it off). So a new
person can see one task run before adding a card. Only one trial box runs at
a time (a second chat is asked for the card), terminals, processes,
Browser/ComputerSessions and viewers still need the card to start a box, and
every other bound still applies. Once the trial time is used, nothing new
joins a box no turn holds, and the reaper drains such boxes
(`compute_card_required`); an in-flight turn finishes, as with a spent day.
The trial covers sandbox time only: model calls still need credit, a
connected subscription, or Free credit (which needs the card).

Chat without a box keeps working. Paid, Enterprise and host-provisioned
organizations, and organizations that bought credit, are never gated. It
builds on the free compute bounds (fleet cap, daily box time, young
organizations, additional-organization holds), which still apply after a card
is verified.

The owner adds a card through Stripe Checkout in setup mode (a SetupIntent,
nothing is charged): `POST /v1/billing/card-verification/setup`, confirmed by
the `checkout.session.completed` webhook or by the page Checkout returns to
(`POST /v1/billing/card-verification/confirm`), whichever comes first. Both
check the SetupIntent and card with Stripe and that the person still owns the
organization, then record the card (`billing_card_verifications`: brand, last
four digits and Stripe's card fingerprint). Prepaid cards and cards whose
security code check failed are refused; the webhook logs such a refusal and
acknowledges the event, since retrying would not change it. A late webhook
for an older SetupIntent never replaces a newer card.
`GET /v1/billing/card-verification` says whether an organization needs one
and whether the caller (its owner) can add it. The console shows one Add a
card action where a box was refused and continues the refused chat once the
card is added; other members are asked to have the owner add it.

One Free grant per card and per person: the first organization whose verified
card reaches Free issuance claims the card's fingerprint and the owner who
verified it together (`opengeni_private.free_trial_card_claims`); an
organization refused for either claims neither. Only Free issuance claims;
model-call admission and sweeps only read the claims. Another organization
with the same card, or verified by the same person, gets no Free credit. To
release a claim (for example after a support review), the database owner
deletes its rows for that organization from
`opengeni_private.free_trial_card_claims`. Another organization of the same
owner inherits their card for sandboxes when that owner acts, never for Free
credit; work without an acting owner (for example a schedule another member
created) needs the organization's own card. The gate covers the Free monthly
credit; a nonzero signup trial grant, where configured, stays spendable. Existing Free organizations without
a card hit the gate at their next box start or Free grant; nothing is deleted,
no ledger is rewritten, and the Free amount is unchanged.

Turn it on only after the release that carries it has finished rolling out:
older processes do not refuse boxes, while the database applies the Free
credit check at once. Switch it with the audited, revision-fenced network
velocity setter (appends a `card_verification_gate_revisions` row; processes
pick it up within 15 seconds):

```sh
bun scripts/operator/promotion-decisions.ts --network-velocity-set --card-verification-mode enforce \
  --revision <current-revision> --operator <operator-id> --reason 'Require a verified card'
```

Rollback: `--card-verification-mode off`. Recorded cards and claims stay; with
the gate off nothing reads them.

## Heedeo shadow scoring

[Heedeo](https://docs.heedeo.com) scores each new account, mostly by matching
the browser and device against earlier signups. Migration
`1565_signup_heedeo_evaluations.sql` adds a deployment-wide mode, `off` by
default:

- `off`: nothing loads, nothing is sent, nothing is stored.
- `shadow`: every signup is scored and the verdict stored. It never blocks
  anyone; compare the verdicts with our own decisions before enforcing.
- `enforce`: as shadow, and a signup Heedeo flags (`flagged: true`, its
  review or block band; a person pressed Trust on is never flagged) is
  refused with the existing generic refusal and no account is created.

Heedeo runs only while the mode is not `off` and both keys are set on the API:
`OPENGENI_HEEDEO_PUBLISHABLE_KEY` and `OPENGENI_HEEDEO_SECRET_KEY` (a private
runtime secret, delivered like the signup challenge secret and never sent to
the browser). Optional: `OPENGENI_HEEDEO_API_URL` (default
`https://app.heedeo.com`), `OPENGENI_HEEDEO_SCRIPT_URL` (default
`https://heedeo.dev/i.js`) and `OPENGENI_HEEDEO_TIMEOUT_MS` (default 1500,
clamped to 100–5000). With the mode on and a key missing, signups go on and
record `skipped` with `missing_keys`.

How it works:

- While the mode is on, `GET /v1/config/client` gives the browser
  `auth.heedeo` (publishable key and script URL), and the sign-in and sign-up
  pages and the add-account window load Heedeo's script. The console's
  Content-Security-Policy lists the script's origin for `script-src` and
  `connect-src` whenever both keys are set.
- Each signup path asks the script for a single-use token (`identify()`), for
  at most 1.8 seconds, and never waits longer or fails because of it: email
  sign-up sends it in the request, every Google or GitHub click carries it in
  the server-owned OAuth state (5 minutes, bound to the provider) to the
  callback, and passkey sign-up sends it with the final request.
- The API sends one `signup` event per new account from the user-create hook,
  after our own refusals (allowed addresses, paused signups, signup
  challenge), just before the account exists: the token (if any), the email
  (never a passkey placeholder), the trusted client address, Heedeo's request
  header subset (never cookies or authorization), a request id, and for
  Google and GitHub the provider and whether it verified the email. The call
  takes at most `OPENGENI_HEEDEO_TIMEOUT_MS`, retrying a 5xx once within it. A
  timeout, network error, 4xx (including 401/403 and 429), 5xx or malformed
  answer fails open in every mode and is stored as `error`.

Stored: `opengeni_private.signup_heedeo_evaluations`, one row per evaluated,
skipped or refused signup while the mode is on, kept 180 days (the runtime
deletes older rows as it writes). Columns: `data_schema`, `id`, `created_at`,
`user_id` (`auth_users.id`; null for an enforce refusal), `signup_method`
(`email`, `google`, `github`, `passkey`, `other`), `mode` (`shadow`,
`enforce`), `outcome` (`evaluated`, `error`, `skipped`, `refused`),
`error_code`, `http_status`, `latency_ms`, `token_present`, `no_token`,
`evaluation_id` (Heedeo's `event_id`), `score`, `band` (Heedeo's
`suggested`), `flagged`, `reason_codes` (codes only) and `visitor_id`
(Heedeo's `visitor.id`, Heedeo's own opaque id, kept as returned so it can be
looked up in Heedeo). No email, address or reason text is stored. The runtime
may only insert rows and delete expired ones; operators and analytics read
them as owner. To join a verdict to the organization the signup created:
`managed_accounts` with `external_source = 'better-auth:user'` and
`external_id = user_id` (its `id` is the organization; for every organization
the user owns, use `organization_memberships.subject_id = 'user:' || user_id`
with role `owner`), then `promotion_decisions` and
`opengeni_private.promotion_decision_history` on `(data_schema, account_id,
revision)` for our own decision, rule and policy version.

Switch it with the audited, revision-fenced network velocity setter (appends a
`opengeni_private.signup_heedeo_mode_revisions` row; processes pick it up
within 15 seconds), or the ops workflow's JSON changes
`{"heedeoSignupMode":"shadow"}`:

```sh
bun scripts/operator/promotion-decisions.ts --network-velocity-set --heedeo-signup-mode shadow \
  --revision <current-revision> --operator <operator-id> --reason 'Heedeo shadow scoring'

# Recent verdicts with each owner's organizations and our decision (codes and ids only)
bun scripts/operator/promotion-decisions.ts --heedeo-verdicts --limit 100
# One organization's owners: --show adds heedeoVerdicts beside its decision history
bun scripts/operator/promotion-decisions.ts --show --account <organization-uuid>
```

Rollback: `--heedeo-signup-mode off` (or `{"heedeoSignupMode":"off"}`); the
browser stops loading the script and nothing more is sent or stored. Stored
rows stay until they age out; the database owner may delete them sooner.

Enforce caveats: every path above is scored before the account is created, so
enforce can refuse each of them. Turn it on only after the release has rolled
out everywhere (older processes don't score), and after reviewing shadow
verdicts. Privacy: the script reads the browser on Heedeo's full collection
profile (its default), and Heedeo receives the email and address of each new
signup; mention Heedeo in the privacy policy before turning it on.

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
