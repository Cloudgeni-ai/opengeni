---
"@opengeni/codex": patch
"@opengeni/runtime": patch
---

Switching a chat to a Codex subscription after the model edited files with native apply_patch no longer fails with `400 missing_required_parameter: input[N].status`. The Responses input schema requires `status` on apply_patch, computer, local shell and program-output items, as well as on hosted search, code interpreter and image-generation calls, but history and the Codex request normalizer kept it only for hosted calls. All of these item types now keep their status in stored history and in every request, and a type check against the OpenAI SDK fails when that list goes stale. Chats that already failed this way after apply_patch work again on Retry, without changes to stored history.

Reasoning is also never resent as text after a model, provider or billing switch. Reasoning that the new route can't accept natively (another provider's encrypted reasoning, Claude thinking on another API, including Claude progress updates stored as assistant messages, Chat reasoning, or unsigned reasoning on Claude Chat routes) is left out of the request. Before, it was sent as "[Historical reasoning from another model]" or "[Historical reasoning without a provider signature]" assistant text, which could trip a provider's safety systems. Stored history is unchanged, so switching back to the issuing provider still replays it natively.
