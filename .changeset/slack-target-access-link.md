---
"@opengeni/api-router": patch
---

Let a Slack access-request link name the workspace a routed conversation actually works in, instead of only the installation's own. Both intent routes now assert that the installation binding resolves for the token's team, that it is the same connection the token was minted against, and that the named workspace belongs to that installation's organization.
