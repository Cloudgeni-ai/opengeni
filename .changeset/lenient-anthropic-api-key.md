---
"@opengeni/api-router": patch
---

Connecting an Anthropic API key accepts every Anthropic key kind, including the newer personal (`sk-ant-usr-…`) and service-account (`sk-ant-svc-…`) keys, which the old `sk-ant-api…` format check rejected. Pasted keys are cleaned up: spaces, line breaks, invisible characters, quotes, env-file lines (`export ANTHROPIC_API_KEY="…"`) and labels before `sk-ant-` such as `Bearer ` are removed, and Anthropic decides whether the key works. The connection still refuses an empty value and Claude subscription setup or refresh tokens (`sk-ant-oat…`, `sk-ant-ort…`). It now explains that an Admin API key (`sk-ant-admin…`) can't run models, and that a value with characters no API key can contain, such as `…` from a masked copy, isn't a complete key. The key field's placeholder is now `sk-ant-…`.
