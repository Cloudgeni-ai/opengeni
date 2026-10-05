---
"@opengeni/config": minor
"@opengeni/core": minor
---

`OPENGENI_CODE_SEARCH_BILLING_MODE=credits` charges `code_search` calls on turns paid with OpenGeni credits at the judge's provider cost plus `OPENGENI_CODE_SEARCH_CREDIT_MARGIN_BPS` (default 500). Promotional grants that cover the turn's model pay first, then general credits, and workspace and member allowances apply. The default `usage_only` never debits.
