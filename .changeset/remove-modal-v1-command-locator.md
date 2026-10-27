---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Modal commands now use only the byte-offset task-router locator. The batch-index `modal-control-v1` reader, its `ModalLegacyProviderCommand` schema and the append-then-acknowledge output path that only it used are removed.
