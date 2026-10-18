---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Managed browsers on Linux machines no longer fail requests with ERR_NETWORK_CHANGED when containers, bridges or VPN interfaces come and go on the machine. Each managed Chromium now runs in its own network namespace bridged to the host by pasta, keeping the person's UID, host localhost servers, DNS and the DevTools endpoint working. Machines without pasta or user namespaces launch as before, and browser_open then adds one plain line saying page loads can fail when the machine's network changes.
