---
"@opengeni/api-router": patch
---

Slack task delivery now converts model-authored Markdown to Slack mrkdwn at the Slack sink. Progress posts, the recorded `reply`, final results, the terminal update of a coalesced progress post, and approved shared-result publications turn headings into bold lines, `**bold**` into `*bold*`, `[label](https://...)` into `<https://...|label>`, and bullets into `•`, while fenced code blocks and inline code stay byte for byte. Provider citation handles (U+E200 `cite` tokens) are removed before posting. Stored session events and history keep the exact text. An operation that an earlier release already bound to the unformatted bytes keeps them: the post and update ledgers report the digest conflict before any provider call, and delivery retries once with the unformatted bytes under the same operation id.
