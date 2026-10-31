---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

Automatic chat titles now use the language the person writes in, and a chat that opens with only a greeting, thanks or small talk is no longer named after the greeting (for example "Casual Greeting"). It stays untitled, so apps keep showing the first message, until a message with a task, question or subject arrives; that message then sets the title.
