---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": patch
---

Calls on a person's own provider key or subscription pay a platform fee (`OPENGENI_BYOK_PLATFORM_FEE_BPS`, default 500 = 5% of the list-price equivalent; custom endpoints with no list price use $1.25/$10 per million input/output tokens) while credit billing is active. The fee is payable only from paid credit: a paid plan's credit for app use, then topped-up or operator-granted credits that ordinary spending has not used (it draws promotional credits first). Free, signup and promotional credit never pay it; without paid credit the call is refused with `402 byok_paid_credit_required` and one action: Upgrade to Pro on the Free plan in the app, otherwise Add credits. Paid credit counts a coupon top-up net of its discount, and a past-due plan or leftover Free period never pays the fee; each fee and each top-up, grant or refund records on its row what it did to paid credit, so the ordinary balance read computes paid credit in one pass. Fee debt is never repaid by plan or promotional credit; the next top-up repays it first. Migration 1102 (rolling) makes `plan_period_usage` count only the plan-paid part of a fee and lets `plan_app_general_balance` keep debt from fees charged to credits out of plan credit, matching the app's balance. The web app shows these refusals as credit stops. See `docs/billing-origin.md`.
