---
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Add low-cardinality money and per-model usage metrics: `opengeni_model_responses_total{provider,model,priced}`, `opengeni_model_tokens_total{provider,model,type}` (input, cached input, cache write, output, reasoning), `opengeni_model_provider_cost_micros_total{provider,model,payer,pricing_source}` (estimated upstream cost), `opengeni_model_credits_charged_micros_total{provider,model,funding}` (credits debited, promotional grant vs general credit), and paid credit purchases `opengeni_credit_purchases_total{mode}`, `opengeni_credit_purchased_micros_total{mode}` and `opengeni_credit_purchase_paid_usd_micros_total{mode}`. `model` is the bounded deployment catalog product id; account and user ids are never labels. A raced Stripe checkout delivery no longer double-counts `opengeni_credit_micros_total{kind="topup"}`.
