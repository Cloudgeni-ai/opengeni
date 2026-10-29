---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/vaults": patch
"@opengeni/vaults-bitwarden": patch
"@opengeni/vaults-protonpass": patch
"@opengeni/runtime": patch
---

Preserve WebAuthn backup eligibility and backup state when importing vaulted passkeys into managed Chromium. Bitwarden, Vaultwarden and Proton Pass passkeys now retain the flags their authenticators used at registration, preventing relying parties from rejecting an otherwise correctly signed assertion. Hosted registrations retain their own flags. Negotiate flag support before sending it, keeping older controllers and APIs compatible with the original sync format.
