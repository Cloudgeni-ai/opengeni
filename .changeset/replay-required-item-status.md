---
"@opengeni/codex": patch
"@opengeni/runtime": patch
---

Switching a chat to a Codex subscription after the model edited files with native apply_patch no longer fails with `400 missing_required_parameter: input[N].status`. The Responses input schema requires `status` on apply_patch, computer, local shell and program-output items, as well as on hosted search, code interpreter and image-generation calls, but history and the Codex request normalizer kept it only for hosted calls. All of these item types now keep their status in stored history and in every request, and a type check against the OpenAI SDK fails when that list goes stale. Chats that already failed this way work again on Retry, without changes to stored history.
