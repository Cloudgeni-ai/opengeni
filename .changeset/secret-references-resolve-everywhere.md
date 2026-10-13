---
"@opengeni/runtime": minor
"@opengeni/api-router": patch
---

Secret references follow one rule in every tool call: a reference resolves where it is written, including Opengeni's own tools such as admin actions, messages, schedules and goals, and an escaped reference passes on unresolved for later work. Interaction tools (resolved by the API at dispatch) and the secret tools, whose arguments name references, keep their arguments unchanged. The agent instructions and the secrets skill describe the escape for handing a reference on.
