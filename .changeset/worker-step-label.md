---
"@opengeni/react": patch
---

The timeline step for starting a worker now reads "Started a worker" instead of "Got help from another assistant", which claimed the help had arrived when the worker had only started. A worker started through `tool_invoke` now shows as the same worker card (title, status, link to the worker) as one started directly.
