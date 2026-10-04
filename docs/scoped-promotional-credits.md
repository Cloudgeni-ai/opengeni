# Promotional credit coverage

Signup and coupon credits share a model list. Offers can override it. Coverage
can change for existing and new promotional balances; issued amounts and spent
credits stay unchanged. Legacy unrestricted grants remain unrestricted.

## Change models without redeploying

Keep a JSON policy outside the repository:

```json
{
  "defaultModelIds": ["model-a", "model-b"],
  "offers": {
    "coupon_example": { "label": "Launch credits" },
    "coupon_another": { "label": "Special offer", "eligibleModelIds": ["model-b"] }
  }
}
```

Use canonical credit-funded IDs from the deployment's model catalog. The command
validates them against that catalog. Optional `signupModelIds` overrides signup
coverage. Offer keys are Stripe **coupon IDs**, not customer-entered codes.
Removing an override makes that offer use the shared default again. Empty lists
are rejected. Labels appear in billing.

Using the migration owner's `OPENGENI_MIGRATIONS_DATABASE_URL` (or
`OPENGENI_DATABASE_ADMIN_URL`) and the deployment's catalog configuration:

```sh
bun run credits:policy --show
bun run credits:policy --file /private/credit-policy.json --operator operator-name --reason "Update covered models"
```

The file replaces the entire runtime policy atomically. Keep the previous file to
roll back with the same command. Every update records a revision, operator and
reason. Runtime API/worker roles can read policy but cannot change it. The
owner-only SQL equivalent is `set_credit_promotion_policy(jsonb, text, text)`;
SQL callers must validate model IDs against their catalog themselves.

Changes apply on the next balance read, model-picker refresh or model-call check.
There is no process cache or restart. A call already admitted retains that
revision for its charge; the next call uses the new policy. Existing conversations
never silently switch models. A removed model can continue using general credits
if available, or pauses for credits.

## Activate

Deploy migration 0613 and all API/worker readers and debit writers **before**
enabling scoped credits. Provision database roles as usual. Apply the runtime
policy using the command above. Keep the signup grant's existing enablement
switches. Do not roll back readers/writers while scoped balances remain.

`OPENGENI_CREDIT_PROMOTION_POLICY_JSON` is an optional bootstrap fallback until
an operator writes the first runtime revision. Runtime policy then supersedes
that environment value. With neither configured, grants retain legacy unrestricted
behavior. Enabling policy does not restrict previously unrestricted grants.

## Customer flow

Signup and redemption show the credit amount without promising specific models.
The open model picker shows **Free credits**, **Uses credits**, or **Needs credits**.
These labels stay inside the menu; the closed selector keeps its model and effort.
**Free credits** appears only while a remaining promotional balance covers that
model. With general credits only, credit-funded models show **Uses credits**.
With no usable balance for a model, it shows **Needs credits**. Subscriptions,
customer provider connections and unmetered models keep their ordinary labels.
Billing shows each remaining balance; **View models** reveals current coverage.
Eligible model usage spends free credits first, then general credits. General
credits include purchases and unrestricted legacy grants.

A scoped coupon redeems its fixed amount through a $0 Stripe checkout. It cannot
be enlarged into a partially paid package. Paid top-ups are separate, with no
Stripe promo-code field. Checkout metadata preserves scoped status, initial
eligibility and offer identity; fulfillment never turns a scoped checkout into
unrestricted purchased credits. The current policy determines its coverage,
including when an old checkout is completed after an operator update.

Promotions do not fund embeddings, video generation or warm sandbox time.
Post-use platform debt stays in general credits. There are no credit reservations
or automatic card charges. Debits and grant allocations commit together under
an account lock, with idempotent receipts including zero-cost settlements.
