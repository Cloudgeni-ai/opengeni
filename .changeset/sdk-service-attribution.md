---
"@opengeni/sdk": minor
---

Add the server-side `client.asService(name, context?)` helper for explicit
automation attribution without changing the original client's credentials or
permissions. Validate bounded service names and flat JSON context, preserve the
client class and options, and reject mixed service/user attribution rather than
silently switching authority. Document product-owned background jobs and
repository credential providers in the integration guide and client Skill.