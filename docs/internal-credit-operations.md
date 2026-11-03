# Internal credit operations

This is the operator path for a bounded, authorized grant to a **confirmed
internal organization**. It reuses the private `Cloudgeni-ai/opengeni-ops`
manual-credit operator; it introduces no billing API, automatic top-up, plan
change, customer notification, or exemption from metering.

## Establish the account and the need

An organization ID is its billing account ID. Reverify the live account name,
owner and active memberships before granting; an analytics classification or
email domain alone is not grant authority. CloudGeni's production embedding
host is `25eacc5d-f383-4f79-910a-b3d11dbf1310`. The team's staging organization is
`049d0b24-7665-4dbe-a7d8-4c2dc8e5674c`; never substitute it for production.

[`DEFAULT_BILLING_LEGACY_ACCOUNT_IDS`](../packages/config/src/defaults.ts) also
lists the team's production organizations. It preserves legacy funding terms
and skips the own-key fee and new billing restrictions; it **does not issue
credits, renew a plan, or make paid inference free**. A deployment override can
replace that list. Inspect the deployed revision and effective configuration,
not just today's `main`. See
[billing origin](billing-origin.md#internal-accounts-cloudgeni-and-our-team).

The operational BYOK fee pause is independent: `OPENGENI_BYOK_PLATFORM_FEE_BPS`
must remain **0 in production and staging** until the owner changes that
decision. This procedure never changes it, plans, provider keys, credit policy,
spend limits, or monitoring thresholds. Do not treat zero credit on an account
using its own subscription with no metered burn as an automatic grant request.

### Read before writing

Use the existing private-network database access path, with the migration-owner
credential from `opengeni-migrations`. Do not print the URL, put it in argv, or
copy it into evidence. Keep temporary AKS credentials in a task-owned mode-0700
directory. The API pod's Bun SQL client can accept the URL over stdin; run
diagnostics in a read-only transaction. The current account scope GUC is
`opengeni.account_id`, not the obsolete `app.current_account_id`.

Verify membership through the existing authenticated organization-admin
projection (`GET /v1/organizations/:id/members`, see [HTTP API](http-api.md)),
using the actual authorized actor, or the corresponding Organization settings
member view. Merely setting an account GUC does **not** authorize direct reads
of FORCE-RLS `organization_memberships`: the non-bypass migration owner can
receive no rows without the lifecycle/capability context. An RLS-empty result
is not evidence that an account has no members or is internal. Do not manufacture
an actor or relax RLS to fill that gap. Obtain positive identity evidence from
the authorized projection before proceeding with these billing-only reads.

For example, these are read-only SQL statements (the `:'account_id'` syntax is
psql's quoted variable substitution):

```sql
begin transaction isolation level repeatable read read only;
set local statement_timeout = '90s';
select set_config('opengeni.account_id', :'account_id', true);
select id, name from managed_accounts where id = :'account_id'::uuid;
select plan_key, status, current_period_start, current_period_end
from organization_plans where account_id = :'account_id'::uuid;
select read_organization_plan_balance(:'account_id'::uuid, now());
select coalesce(sum(amount_micros), 0)::text as raw_ledger_balance_micros
from credit_ledger_entries where account_id = :'account_id'::uuid;

select type,
  coalesce(-sum(amount_micros) filter (where occurred_at >= now() - interval '24 hours'), 0)::text as debit_24h,
  coalesce(-sum(amount_micros) filter (where occurred_at >= now() - interval '7 days'), 0)::text as debit_7d
from credit_ledger_entries
where account_id = :'account_id'::uuid and amount_micros < 0
  and occurred_at >= now() - interval '7 days'
group by type;

select (occurred_at at time zone 'UTC')::date as day, type,
  (-sum(amount_micros))::text as debit_micros
from credit_ledger_entries
where account_id = :'account_id'::uuid and amount_micros < 0
  and occurred_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '14 days'
  and occurred_at < date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
group by 1, 2 order by 1, 2;

select id, type, amount_micros::text, source_type, source_id,
  idempotency_key, metadata, occurred_at
from credit_ledger_entries where account_id = :'account_id'::uuid and amount_micros > 0
order by occurred_at desc limit 10;
commit;
```

The raw ledger sum is **not necessarily spendable credit**. Use the canonical
[`getBillingBalance`](../packages/db/src/credit-balances.ts) projection to
separate general credit, model-scoped promotions, held funding, pending plan
expiry, and current plan credit. When inspecting with SQL instead, inspect
`eligible_model_ids`, remaining `credit_debit_allocations` and
`read_organization_plan_balance` before reporting general credit. Scoped credit
cannot be assumed to fund every model. A Free plan row with zero granted credit
is not a future allowance or evidence that the host will replenish itself.

Calculate burn from **usage debits**, not net ledger movement: grants/top-ups
are inflows, and `plan_credit_expiry`, `credit_refund` and
`credit_dispute_hold` are not inference/tool consumption. Inspect the returned
types rather than silently including new adjustment types. Use both trailing
24-hour burn and the seven-day average; show complete UTC-day peaks separately.
Partial current days and exhaustion-induced inactivity can understate demand.

One bounded replenishment policy is to target 30 days at the greater of those
two rates and 14 days at the observed recent peak, rounding only the **additional
grant** up to $100. Record the chosen horizon and amount; these are operator
judgments, not a recurring funding promise. If usage is abnormal, investigate
it instead of continually increasing the allowance. One dollar is 1,000,000
USD micros. Keep gross ledger, general/spendable balance and projected runway
distinct in evidence.

## Apply through the existing audited operator

Use a reviewed, merged private ops checkout whose
`ops/manual-credit-grant-cli.ts --help` includes `--database-url-stdin` and
verified replay receipts. This is an operator operation, not an app release.
The CLI is dry-run by default. It uses bound SQL parameters, the application
account credit lock, and the existing ledger type `manual_credit_grant` with
`source_type='operator_adjustment'`. It verifies an existing row matches the
entire requested grant rather than accepting any idempotency-key collision.

Record explicit authorization, environment, account, amount, operator identity,
reason, source/ticket ID, and one stable idempotency key **before execution**.
Use the same full request after an uncertain result; changing the reason or
source can create a second grant when the default key is used. Never use a new
key merely because a command timed out. First inspect the existing row.

From that ops checkout, using a task-owned evidence directory and an authorized
database route:

```bash
# These values are non-secret. Choose the amount from the recorded live audit.
grant_args=(
  --environment production
  --account-id "$ACCOUNT_ID"
  --dollars "$APPROVED_DOLLARS"
  --operator "$OPERATOR_ID"
  --reason "$REASON"
  --source-id "$SOURCE_ID"
  --idempotency-key "$IDEMPOTENCY_KEY"
)
bun ops/manual-credit-grant-cli.ts "${grant_args[@]}" \
  --dry-run --out-file "$TASK/grant-plan.json"

# Bundle the already-reviewed operator; do not depend on API-pod source/deps.
bun build ops/manual-credit-grant-cli.ts --target=bun \
  --outfile "$TASK/manual-credit-grant.mjs"
kubectl -n opengeni cp "$TASK/manual-credit-grant.mjs" \
  "$API_POD:/tmp/$TASK_ID-manual-credit-grant.mjs" -c api

# Bash pipefail is required: a failed credential read must not look successful.
set -o pipefail
kubectl -n opengeni get secret opengeni-migrations \
  -o jsonpath='{.data.OPENGENI_MIGRATIONS_DATABASE_URL}' | base64 --decode | \
  kubectl -n opengeni exec -i "$API_POD" -c api -- \
    bun "/tmp/$TASK_ID-manual-credit-grant.mjs" --database-url-stdin \
    "${grant_args[@]}" --execute \
    --out-file "/tmp/$TASK_ID-credit-receipt.json" > "$TASK/grant-result.json"
```

Omit `--workspace-id` for an organization grant. If supplied for a specific
operational reason, it must belong to the exact account; it does not create a
separate workspace credit balance. `manual_credit_grant` is unrestricted,
paid-class funding in the existing accounting model. It is not the generic
goodwill/promotion `grant` type; see [paid credit](billing-origin.md#paid-credit).

The older **Manual Credit Grant** GitHub workflow is also an existing audited
path, with environment protection and uploaded evidence. Its SQL interpolates
the reason and its success output does not verify an exact replay. Prefer the
parameterized CLI above for free-text reasons and verified retries. If using
that workflow, use a simple quote-free, single-line reason, preserve its full
generated key and independently verify the persisted row; a green run or
`ON CONFLICT DO NOTHING` alone does not prove the requested grant happened.

### Verify and retain the receipt

Check `receipt.inserted`, `receipt.entry` (including ID, amount, source, key,
operator and reason), and `receipt.ledgerBalanceBeforeMicros` /
`receipt.ledgerBalanceAfterMicros`. The string balances preserve bigint
precision and are **raw ledger totals**, not a promise of model coverage.
An exact replay reports `inserted=false`; a conflicting request fails and
does not silently claim success. Ledger rows are append-only: never edit or
delete one to undo a mistake; reconcile and obtain authority for any correction.

Read the persisted row and current billing balance independently after commit.
Recompute runway, account for usage since the original snapshot, and confirm
the credit metric refreshes. Evidence-file failure after commit is an unknown
delivery result, not evidence that the money was not issued. Keep the request
and reconcile/replay the **same key**, never blindly repeat with a fresh key.

Remove only this task's copied pod bundle/receipt, credential directory,
containers and temporary test data once evidence is retained. Do not publish
database URLs, kubeconfigs, tokens, alert webhook URLs, or private membership
details in the public repository.

## Verify monitoring; do not replace it with a large grant

The private ops `observability/uptime-prober/rules.yaml` owns the existing host
rules: `OpenGeniHostAccountCreditsLow` is below $150 for 30 minutes;
`OpenGeniHostAccountCreditsExhausted` is below $5 for 5 minutes (page). These
currently target the CloudGeni host, **not every internal organization**.

Check the loaded Prometheus rules (health, last evaluation and state), a fresh
`opengeni_credit_balance_micros{environment="production",account_id="…"}`
sample, and Alertmanager's live routing, silences and inhibitions. Low credit
must reach warning receivers; exhaustion must reach page receivers. Verify
email/Slack notification activity with no matching delivery failures. A zero
failure count with no attempted deliveries proves little; current inactive
credit alerts do not prove that a specific credit warning was delivered.

Missing metrics are not a zero balance: either threshold expression returns
no alert on an absent series. Diagnose scrape/collector coverage separately.
Follow the private ops [alert receiver runbook](https://github.com/Cloudgeni-ai/opengeni-ops/blob/main/docs/operations/production-alert-receiver.md)
and [uptime runbook](https://github.com/Cloudgeni-ai/opengeni-ops/blob/main/docs/uptime-prober.md)
for routing, delivery tests and narrow configuration
repairs. Preserve the fee pause and existing thresholds; no full production
release is needed merely to issue a grant or inspect these rules.
