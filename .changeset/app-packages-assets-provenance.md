---
"@opengeni/contracts": minor
"@opengeni/db": patch
---

App packages carry a multi-file app's asset files, and install and upgrade restore them. Packages carry a `packageId`: installed copies record it, and upgrading from a different app's package needs `allowDestructive`. Install responses and upgrade plans include it.
