---
"@opengeni/codex": patch
---

Codex usage reads no longer fail when ChatGPT reports `null` for optional fields. The usage response now carries `credits.balance: null` for accounts without purchased credits, which the parser rejected, so every quota read for those accounts returned status `error`: the quota bars showed nothing, quota cooldowns could not be confirmed over, and the production acceptance quota check could not run. Optional fields now accept `null`, a malformed plan label or credit balance no longer discards the quota windows, and feature limits in the current nested `additional_rate_limits` shape are read. A malformed quota window still fails closed.
