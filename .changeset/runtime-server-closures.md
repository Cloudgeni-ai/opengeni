---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Ship API and worker containers with verified frozen runtime dependency closures instead of the development install and checkout. Preserve native parsing/image bindings, conversion tools, signed installers, Skill assets, workflows, migration commands and the stock catalog-import Job. Defer Temporal's source-workflow compiler until compilation is requested, avoiding its retained idle graph for prebuilt workflow hosts.
