---
"@opengeni/api-router": patch
---

When computers are already connected, the Connected Machine card result now tells the agent which of the person's computers are connected and their state, instead of a generic "machines are connected" line. It no longer promises that the person can connect another computer from the card, since that depends on the app and the device they're on, and it tells the agent that a computer the person means but isn't listed is not connected. The Chrome extension it names is the deployment's own, linked only when the link is for that extension.
