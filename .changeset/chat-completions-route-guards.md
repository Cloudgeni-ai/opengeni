---
"@opengeni/runtime": patch
---

The API imports stateless single model calls through a narrow `@opengeni/runtime/model-calls` entry instead of the runtime barrel, the chat completions stream is classified as a non-document response, and the organization action catalog lists the models and chat completions routes.
