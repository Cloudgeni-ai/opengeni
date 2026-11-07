---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

An agent moving its turn onto a personal (Only me) Connected Machine whose approval for the turn was used up, revoked or expired now gets a typed refusal instead of a raw database error. `sandbox_swap`, `sandbox_attach` and `run_on` return the new code `machine_access_required`, whose reason starts with "Machine access needed: this chat isn’t allowed to use “<machine>” right now.", and the chat stays on its current machine. That sentence now comes from one shared helper, `machineAccessNeededMessage` in `@opengeni/contracts`, used by the failed-turn banner, the worker's turn failure and the refusal. When an action can't send because the chat has ended or is archived, it now says "This chat has ended. Start a new chat." or "This chat is archived. Continue in a new chat." instead of mentioning a repository, because Allow and Continue show the same text as the GitHub card.
