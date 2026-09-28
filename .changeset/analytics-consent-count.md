---
"@opengeni/contracts": minor
---

Add the wire grammar of the public, content-free `POST /v1/analytics-consent`
beacon as `@opengeni/contracts/analytics-consent-report`: the path, the closed
`granted` / `denied` decision list, and the body size limit. The API counts each
report in `opengeni_analytics_consent_total{decision}` so product reports can
state how much of the audience consent-gated analytics never sees.
