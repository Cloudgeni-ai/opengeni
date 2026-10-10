---
"@opengeni/runtime": patch
---

Reduce Connected Machine browser and computer controller request overhead by streaming small requests and binary responses through one existing command operation. Keep authority on stdin, preserve controller binding validation, and never retry an uncertain mutation.
