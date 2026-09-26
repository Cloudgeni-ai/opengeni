# Credit boundaries and optional usage charges

This change separates OpenGeni-funded model/video usage from sandbox warm time,
Knowledge embedding, and unpriced source preparation. Do not activate a new
customer charge simply by deploying the migration or enabling Stripe.

## Safe baseline

Keep `OPENGENI_VERIFIED_SIGNUP_TRIAL_CREDITS_ENABLED=false`,
`OPENGENI_SANDBOX_WARM_BILLING_MODE=usage_only`, and
`OPENGENI_DOCUMENT_EMBEDDING_BILLING_MODE=usage_only` when upgrading. With this
posture, existing model/video rails remain the only charged resources. The new
warm/embedding usage facts can be observed without a customer debit. A zero
balance must not prevent an unpriced sandbox or document source from working;
model and OpenGeni-funded video admission still enforce their own credits.

The signed ledger is account-wide. A new verified managed human completing the
first self-service organization setup can receive exactly one $10 grant once
the trial flag is enabled. Invited users, later organizations, retries, and
pre-existing setup receipts do not receive a second grant. The trial has no
card requirement or expiration in this campaign. It is ordinary account credit
and can pay any resource actually billed in OpenGeni credits, including models
and video; optional paid sandbox/document work can use it only if separately
enabled. A completed or already-running operation may leave the account below
zero; later purchased credits reduce that negative balance first. No card is
charged automatically for the difference. Email verification is not unique-
person proof, so monitor grants and abuse before scaling the offer.

## Staged activation (separate operator change)

1. Deploy the compatible app and additive migrations with all three controls
   at the safe defaults. Check existing first-organization setup, replay,
   invitation, source preparation, sandbox attach, keyword search, model/video
   funding, and the absence of new sandbox/document customer ledger debits.
   Run owner-migrated PostgreSQL/RLS tests before any production rollout.
2. Choose and review sandbox rates per backend and document input-byte tariff.
   Paid sandbox rates must be safe integer USD micros per second so the total
   does not change with heartbeat frequency. `usage_only` is an immediate
   rollback for new and existing warm leases; previously committed debits stay
   in the ledger. A durable pre-stop charge cutoff keeps final retry settlement
   from charging time after a provider was asked to stop.
   `OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON` and
   `OPENGENI_DOCUMENT_EMBEDDING_RATE_MICROS_PER_MILLION_BYTES` do **not** receive
   commercial values from this PR. Paid OpenAI embeddings also require an
   explicit `OPENGENI_DOCUMENT_EMBEDDING_CREDITS_ACTIVATED_AT` ISO UTC cutoff;
   jobs queued before that instant must remain unpriced when the mode changes.
   Observe `shadow` one mode at a time on a
   known test account; Knowledge's `document.embedding_shadow_estimate` usage
   event records an internal micro-USD estimate, not customer spend. Check provider
   costs, shared-box once-only metering, vector query traffic, and retry rates.

   Terraform-backed managed stacks render the reviewed warm-rate JSON into
   both the private runtime environment and Helm values. Non-Terraform
   Kubernetes stack plans do not run that generator: set both
   `config.OPENGENI_SANDBOX_WARM_BILLING_MODE` and
   `config.OPENGENI_SANDBOX_WARM_RATE_MICROS_PER_SECOND_JSON` in the reviewed
   Helm values file, using the actual backend key (`modal` or `opensandbox`).
   Verify the rendered ConfigMap and API/worker pod environments before
   enabling charges. Exporting paid warm settings only into the stack-plan
   environment now fails instead of silently deploying the free chart default.
   The trial and document switches on these non-Terraform profiles likewise
   require explicit reviewed Helm values; neither is enabled by a shell export.
3. If a verified-email signup campaign is approved, enable the trial flag
   separately. Confirm new receipts get one $10 ledger entry, old receipts and
   invitation accounts get none, and balance/top-up screens handle negative
   values. Track campaign grants and registrations per period for abuse.
   Once migration 0521 is live, grants also need its database runtime switch,
   which starts enabled. To stop grants during abuse, turn that switch off. Do
   not change the environment flag for this: that needs a config rollout and
   an API restart. The runtime switch applies to the next setup transaction
   without either. A setup made while it is off completes without the credit,
   and turning it back on does not backfill that setup. See "Verified signup
   trial runtime switch (0521)" in [`deployment.md`](deployment.md) for the
   audited setter, the state query, and the
   `opengeni_verified_signup_trial_credits_runtime_enabled` gauge.
4. Activate one paid resource mode at a time on a controlled deployment only
   after its real database, failure-injection, and UI tests are green. Verify
   positive-balance admission for *new* work, idempotent full post-use settlement
   and possible negative balance for work already underway, customer-owned
   compute bypass, funding-wait/resume for semantic indexing, and preservation
   of source/keyword access. Paid Knowledge embedding also waits for the exact
   revision to be published; pending or rejected review drafts are not charged.
   Then expand gradually using operator review.

   If paid Knowledge embedding is turned back to `usage_only` (or `shadow`), an
   unfinished generation that already froze `credits` keeps its completed batches
   and tariff, but defers further embedding, chunk appends, usage and debits.
   Source and keyword access remain available. The existing retry backoff
   continues until paid embedding is restored, at which point the generation
   resumes using its original rate (even if the configured rate has changed).
   Completing it under a different billing policy requires explicit reconciliation;
   the rollback switch does not silently reprice it. Generations frozen as
   `usage_only` or `shadow` remain on their original policy.

Do not treat a `shadow` estimate as a debit or a provider bill. Leave quotas
independent of tariff: an exhausted monthly chunk cap is not `awaiting_funding`.
On any billing mismatch, set the affected resource mode back to `usage_only` and
reconcile already-committed ledger entries explicitly; changing a mode does not
erase historical charges. Keep usage, ledger, failed-settlement and funding-wait
signals visible to operators. A rollback of the binary across new migration
contracts may need the deployment-specific maintenance procedure; do not assume
restarting an old image is safe.