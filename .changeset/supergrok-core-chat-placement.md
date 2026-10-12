---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/xai-subscription": patch
---

Prepare SuperGrok chat turns for the shared subscription core. A SuperGrok turn reads its provider route once: without the SuperGrok cutover it runs exactly as before; during maintenance it fails with typed copy; on the core it is placed, leased and funded like a Codex turn, every model request is reserved and settled before and after it goes out, and an unknown outcome is never replayed. The SuperGrok transport gains request identity and settlement hooks. Nothing changes today: no organization has the SuperGrok cutover, so SuperGrok and Codex behave exactly as before.
