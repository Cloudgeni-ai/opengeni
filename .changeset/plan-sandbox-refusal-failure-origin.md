---
"@opengeni/observability": minor
"@opengeni/worker-bundle": patch
---

A turn that fails because the organization's plan refuses a sandbox (no paid plan or credit, a card to verify, or the Free plan's daily box time spent) now counts as `failure_origin="customer_plan"` instead of a platform failure, and the turn-failure alert and Runtime Failures dashboard leave it out of the platform ratio.
