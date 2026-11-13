---
"@opengeni/config": minor
"@opengeni/runtime": patch
---

Ultrafast turns on a Codex subscription no longer ask for a reasoning summary, so the answer starts sooner.

- On Codex the answer waits until the summary is written. On GPT-6.1 Sol at Ultrafast and medium effort, the first answer token came a median 1.3 s (WebSocket) to 2.4 s (HTTP) sooner without it.
- These turns show no thinking row. Every other speed and route sends exactly what it sent before: `detailed` on Codex, `auto` on direct OpenAI and Azure.
- `OPENGENI_REASONING_SUMMARY_JSON` sets the summary per route (`codex`, `openai`, `azure`) and speed (`standard`, `priority`, `fast`, `ultrafast`) to `auto`, `detailed` or `none`, for example `{"codex":{"fast":"none"}}`. Cells you leave out keep their defaults; an unknown route, speed or value fails startup.
