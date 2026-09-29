---
"@opengeni/contracts": minor
"@opengeni/api-router": patch
---

Add a public, content-free `POST /v1/analytics-consent` beacon that counts
answers to the web console's optional-analytics banner in
`opengeni_analytics_consent_total{decision}` (refusals in
`opengeni_analytics_consent_reports_rejected_total{reason}`), with a streamed
128-byte body limit, a same-deployment `Origin` check and per-decision
admission bounds, so product reports can state how much of the audience
consent-gated analytics never sees. The wire grammar (path, closed `granted` /
`denied` decision list, and body size limit) is exported from
`@opengeni/contracts/analytics-consent-report`.
