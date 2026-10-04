---
"@opengeni/db": patch
---

Reject empty coupon IDs and invalid text boundaries in SQL credit policy updates,
preserving the active policy when an update cannot be read by the application.
