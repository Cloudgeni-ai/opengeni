---
"@opengeni/db": patch
---

Organization usage reads and the Codex Apps refresh now record the plan a refreshed token reports. These three refreshes still wrote the connection row themselves and dropped the plan, so an organization-managed connection whose ChatGPT plan changed kept showing the old one. Migration 1515 adds one refresh write that every refresh path now uses. It stores the credential, compares and swaps the refresh generation, and records the plan (a token that reports none keeps the recorded plan). When the plan changes, it also clears the connection's model cooldowns. The write runs with the caller's own rights, so organization administrators are admitted by the same policy as before.
