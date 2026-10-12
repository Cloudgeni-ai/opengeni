---
"@opengeni/config": patch
---

Reviewed Codex GPT-6 models declare runnable structured output (JSON-schema `text.format`, as the Codex CLI's `--output-schema` sends it), so single calls can request `json_schema` on them. A turn accepted before a model's structured output was enabled from the unknown/off declaration stays runnable; agent turns never request structured output. Docs note that the Codex backend ignores sampling and output-length controls.
