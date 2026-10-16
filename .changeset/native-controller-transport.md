---
"@opengeni/agent-proto": patch
"@opengeni/runtime": patch
---

Browser and computer actions on Connected Machines and attached Chrome are faster. The agent now forwards each controller request itself over loopback, instead of starting a shell, curl and base64 for every click, screenshot or state check. Large responses such as screenshots are read back in pieces, so they stay within the message size limit. Older agents that do not advertise this keep using the previous path.
