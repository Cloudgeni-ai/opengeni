---
"@opengeni/contracts": patch
---

Accept canonical host-native source paths in retained file-publication receipts.
Connected Machine publication now resolves and confines paths using the active
filesystem root instead of assuming a managed `/workspace` root.