---
"@opengeni/contracts": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
---

Source links in answers no longer carry the tracking that OpenAI's hosted web search adds to the pages it finds: `utm_source=openai` (or a ChatGPT value) and `_t_q`, the search query that found the page. Chat timelines (web, desktop and mobile), copied text, the opened-page line of a web search, the notification inbox, phone push text, Slack and Teams now show the clean link; the page's own parameters, the fragment and code stay exactly as written. Only links carrying the provider's `utm_source` value are changed. Stored history and anything sent to the model keep the links as the model wrote them, and a Slack message an earlier release already started keeps that release's bytes on retry. `@opengeni/contracts/citation-urls` exports `withoutProviderTracking` and `withoutProviderTrackingInText` for other surfaces, such as products that render the raw chat stream.
