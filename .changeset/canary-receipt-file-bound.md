---
---

Fix canary publishing failing without a usable failure record when the npm registry is slow to show a large package. The receipt file bound (2048) was smaller than the default read budget needs, so a long wait for `@opengeni/runtime` ran out of files before the read quota or deadline, and reconciliation then refused the incomplete receipts. The bound now covers the largest read budget, and the reconciliation reader admits the same count.
