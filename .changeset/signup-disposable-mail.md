---
"@opengeni/db": patch
"@opengeni/config": patch
---

New self-serve organizations (first and additional) start held when the owner's mail domain, or its MX host, is a temporary-inbox service (rule `disposable-mail-v1`; the API checks the MX at setup with a bounded, cached lookup that fails open, and records only the flag), and when 3 or more owners of one company domain set up within 24 hours and none of their organizations ever used the product (`email-slow-domain-v1`). Both legs enforce by default and have their own mode in the signup settings (migration 1493). New settings: `OPENGENI_SIGNUP_DISPOSABLE_MAIL_DOMAINS` (more providers) and `OPENGENI_SIGNUP_MAIL_MX_LOOKUP_TIMEOUT_MS` (1500; 0 turns the lookup off).
