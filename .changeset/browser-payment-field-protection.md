---
"@opengeni/contracts": patch
"@opengeni/browser-extension": patch
---

Keep known numeric secrets masked when payment widgets add digit grouping, and
redact complete three-digit security codes without shortening the existing
clipped-password prefix threshold. Browser protected-field discovery now covers
accessibility as well as DOM reads, including frames and flattened closed
shadow roots. Payment fills accept formatting-only grouping, not changed digits.
Browser tabs that encounter payment fields or known card data withhold screenshots,
live frames and video while preserving semantic controls and unrelated tabs. Privacy-discovery and masking
failures withhold output instead of returning unprotected data.
The Chrome extension admits the read-only privacy snapshot method. Hidden
metadata and expiry options stay protected in place without becoming session
secrets; remembered card numbers and security codes cannot age out behind
unrelated values.
The extension advertises the additive privacy capability to the native agent;
older extensions receive the existing update-required refusal and start
Chrome's update check before protected reads are allowed.
