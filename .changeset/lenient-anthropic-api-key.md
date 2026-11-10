---
"@opengeni/api-router": patch
---

Connecting an Anthropic API key accepts every Anthropic key kind, including the newer personal (`sk-ant-usr-…`) and service-account (`sk-ant-svc-…`) keys, which the old `sk-ant-api…` format check rejected. Line breaks, spaces, invisible characters and wrapping quotes picked up while pasting are removed, and Anthropic decides whether the key works. The connection still refuses an empty value and Claude subscription setup or refresh tokens (`sk-ant-oat…`, `sk-ant-ort…`), and it now explains that an Admin API key (`sk-ant-admin…`) can't run models.
