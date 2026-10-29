---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/vaults": patch
"@opengeni/vaults-bitwarden": patch
---

Preserve WebAuthn backup eligibility and backup state when importing vaulted passkeys into managed Chromium. Bitwarden and Vaultwarden passkeys now retain the flags their authenticator used at registration, preventing relying parties from rejecting an otherwise correctly signed assertion. Hosted registrations retain their own flags, while older credentials keep their existing defaults.
