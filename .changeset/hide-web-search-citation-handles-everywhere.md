---
"@opengeni/contracts": minor
"@opengeni/react": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Web-search citation handles no longer show on any surface that displays an answer. OpenAI models that search the web through a Codex or ChatGPT subscription write citations as private-use handles (U+E200 `cite` U+E202 `turn0search3` U+E201). The responses carry nothing that maps a handle to a page, so people saw `citeturn0search3` in the text. The chat timeline and Slack already removed them. Now the notification inbox (web, desktop banners and mobile, through the inbox API), phone push text, Teams replies, shared chat links and a worker's report in its manager's chat remove them too. Stored history and anything sent to a model keep the exact text. `@opengeni/contracts/provider-citation-handles` exports `withoutProviderCitationHandles` for other surfaces, such as products that render the raw chat stream.
