---
"@opengeni/api-router": patch
---

Connecting an Anthropic API key no longer fails on a strict key-format check. Line breaks, spaces, invisible characters and wrapping quotes picked up while pasting are removed. Any other Anthropic key is accepted and Anthropic decides whether it works. Only an empty value or a Claude subscription setup token (`sk-ant-oat…`) is refused, with the existing pointer to Claude subscription.
