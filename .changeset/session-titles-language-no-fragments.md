---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
---

Automatic chat titles follow the chat's language when the person's first message is only a link, a file or code: the title request gets a short excerpt of the chat's own instructions (session, agent or workspace identity text) as a language sample, and the `set_session_title` descriptions say to use the instructions' language in that case. An automatic title candidate longer than 10 words or 80 characters is now refused instead of cut, so a model reply or an agent's goal never becomes a sentence-fragment title; `normalizeAutomaticSessionTitle` takes `{ shorten: true }` for labels that should keep the old shortening (scheduled-run names, work-claim labels).
