---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": patch
---

Calls on a person's own provider key or subscription pay a platform fee (`OPENGENI_BYOK_PLATFORM_FEE_BPS`, default 500 = 5% of the list-price equivalent; custom endpoints with no list price use $1.25/$10 per million input/output tokens) while credit billing is active. The fee is payable only from paid credit: a paid plan's credit for app use, then topped-up or operator-granted credits that ordinary spending has not used (it draws promotional credits first). Free, signup and promotional credit never pay it; without paid credit the call is refused with `402 byok_paid_credit_required` and one action: Upgrade to Pro on the Free plan in the app, otherwise Add credits. Paid credit counts a coupon top-up net of its discount, and a past-due plan or leftover Free period never pays the fee; each fee and each top-up, grant or refund records on its row what it did to paid credit, so the balance read takes paid credit from those rows alone (through the new partial index `credit_ledger_receipt_rows_idx`) and an account without fees reads its balance as fast as before. Fee debt is never repaid by plan or promotional credit; the next top-up repays it first. Migration 1108 (rolling) makes `plan_period_usage` count only the plan-paid part of a fee and lets `plan_app_general_balance` keep API debt and unpaid fee debt (not fees paid in full) out of plan credit, matching the app's balance; migration 1109 builds the index concurrently. The web app shows these refusals as credit stops. See `docs/billing-origin.md`.
