---
"@opengeni/tool-gateway": patch
---

Tool calls that send a number as a plain decimal string (for example "25" for an integer field) are now accepted and run with the number. Only strings at fields the schema requires to be an integer or number are converted, and only when the whole call then validates; all other type mismatches are still rejected.
