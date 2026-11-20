---
"@opengeni/browser-extension": patch
"@opengeni/agent-host": patch
"@opengeni/desktop": patch
---

Branded browser extensions use their own native host registration so they can run alongside Opengeni Browser and connect to their own desktop runtime. Update the branded extension and its agent together; the standard Opengeni Browser host name is unchanged.
