---
"@opengeni/core": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
---

In a Personal workspace, Connect provider now opens the key form for that workspace for OpenRouter, Vercel AI Gateway, Opper and Anthropic, as it already did from an organization key's page; organization keys can't be used there. Sandbox environment versions and changes, and Site Data records, now show the person's name (or "you") instead of a raw `user:user:<id>`. New sandbox environment versions record the person's subject once (`user:<id>`); older versions still show the right name. Site Data owners keep their documented form. Removes the unused Site agent member SQL tool list and corrects a stale comment about Site agent workspace tools.
