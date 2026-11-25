# Custom credit offers

A custom credit offer is sponsored credit an operator assigns to one
organization: a configurable amount, a fixed list of models it pays for, how
many days it lasts once activated, and optionally a date by which it must be
activated. A billing manager of the organization chooses when to activate it
on the billing page. It is the foundation for design-partner and enterprise
terms beyond the self-serve plans; nothing changes for an organization without
an offer.

## Terms

- **Amount and models are per offer.** Nothing is hard-coded: the operator
  sets the grant size in dollars and the model allowlist when assigning. The
  allowlist is fixed at assignment; models added to the catalog later are not
  covered. Runtime promotion policy (`credits:policy`) never changes an
  offer's models.
- **Activation** writes one model-scoped promotional grant
  (`credit_ledger_entries` type `grant`, `source_type` `credit_offer`) that
  expires `validDays` after activation. It is idempotent and refused after the
  activation deadline or once the offer is withdrawn.
- **Spending** follows the existing promotional-credit rules
  ([scoped promotional credits](scoped-promotional-credits.md)): it pays for
  app use of the listed models only, after the monthly plan credit, before
  general credits. Other models and API use pay from credits as before, so an
  organization with no other credit can effectively use only the listed models.
- **Expiry** has no renewal and no overage. Balance reads stop counting an
  ended offer at once, without a worker. Under the account lock,
  `begin_plan_credit_settlement` then writes a `credit_offer_expiry` row for
  the unspent remainder, allocated to the offer's grant, so general credit and
  the monthly plan allowance are unchanged.
- **Withdrawing** an offer before activation makes it unavailable; withdrawing
  an active offer expires it now.

The billing page lists offers waiting for activation and shows an active
offer's remaining credit, models and expiry date in the balance. Billing
managers get an Activate button once self-serve activation is on (below);
until then the page asks them to contact Opengeni support, and an operator
activates the offer for them.

### Self-serve activation rollout

Migration 1563 withholds the runtime's EXECUTE on
`opengeni_private.activate_credit_offer_v1` for one release, because the
previous binary's posture check refuses unknown runtime definer routines. A
migration in the next release grants it; from then on
`GET /v1/billing/credit-offers` reports `selfServeActivation: true` and the
button appears. Until then the activate endpoint answers 409 with a
contact-support message.

## Operate

With the migration owner's `OPENGENI_MIGRATIONS_DATABASE_URL` (or
`OPENGENI_DATABASE_ADMIN_URL`) and the deployment's catalog configuration:

```bash
# $2,000 for every credit-funded Gemini model, valid 8 weeks after activation,
# to be activated by the end of January.
bun run credits:offers assign --account <organization id> --amount-usd 2000 \
  --models-matching gemini --valid-days 56 --activate-by 2027-01-31T23:59:59Z \
  --label "Design partner credits" --operator <name> --reason "<why>"

bun run credits:offers list --account <organization id>
bun run credits:offers activate --account <organization id> --offer <offer id> \
  --operator <name>
bun run credits:offers revoke --account <organization id> --offer <offer id> \
  --operator <name> --reason "<why>"
```

`--models` takes an explicit comma-separated list instead of, or as well as,
`--models-matching`. Every model must be a canonical credit-funded model in the
current catalog; at most 40 per offer. Amounts are up to $1,000,000 and validity
up to 730 days.

## API

- `GET /v1/billing/credit-offers?accountId=` (`billing:read`): the
  organization's offers with status `available`, `active`, `ended`, `lapsed`
  or `withdrawn`, and `selfServeActivation`.
- `POST /v1/billing/credit-offers/{offerId}/activate` (`billing:manage`):
  404 for an unknown offer, 409 once it can no longer be activated or while
  self-serve activation is off.
- `GET /v1/billing` reports an active offer in `promotionalCredits` with
  `expiresAt`.

## Schema

Migration 1563 adds the FORCE-RLS `credit_offers` table (runtime read-only),
the owner-only `assign_credit_offer`, `revoke_credit_offer` and
`expire_credit_offer`, `opengeni_private.activate_credit_offer_v1`, and offer
settlement in `begin_plan_credit_settlement`. Code: `packages/db/src/credit-offers.ts`,
`apps/api/src/routes/billing-credit-offers.ts`,
`scripts/operator/credit-offers.ts`, tests in
`packages/db/test/credit-offers-postgres.test.ts`.

Not yet covered: a sweep that settles ended offers for organizations with no
further usage (reads are already correct), and reporting provider cost of
offer-funded usage against a sponsor's budget.
