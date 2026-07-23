---
"@opengeni/runtime": patch
---

Bundle the OpenAI Agents implementation together with its required Zod 4 runtime so embedding hosts can retain an independent Zod major without silently changing Agents' schema identity, while keeping transitive runtime dependencies explicit and Node-compatible.
