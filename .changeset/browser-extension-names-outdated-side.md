---
"@opengeni/browser-extension": patch
---

When the extension and the computer's agent don't match, the popup now says plainly which side is outdated: "Update the Opengeni agent" (with the agent's version when it reports one) or "Update this extension". When the agent reports the extension as the older side, the extension checks for its own update right away and applies it, since nothing is attached while the agent refuses it. Current agents explain every refused connection (not running, older or newer bridge, or another error), so the popup no longer guesses between "not running" and "too old".
