---
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/events": patch
---

Keep automatic history filling from evicting the latest reply or cycling between older and newer pages. Preserve explicit history navigation and stable jumps back to latest. Retain provider message identity so assistant chunks interleaved with tool activity remain one message without merging distinct replies.