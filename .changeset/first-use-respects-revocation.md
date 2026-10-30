---
"@opengeni/core": patch
"@opengeni/db": patch
---

First-use admission of an external user now respects workspace member removals the same way a stated membership does: a request that authenticated before the user was removed no longer re-creates the membership, even when it states no membership. A request that authenticates after the removal still admits the user.
