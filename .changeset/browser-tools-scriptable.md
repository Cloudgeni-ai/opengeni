---
"@opengeni/runtime": patch
"@opengeni/codemode": patch
"@opengeni/ogtool": patch
---

Make bulk browser work easy to script with Opengeni's own browsers. `navigate` takes an optional `waitUntil` (`load` or `network_idle`), and `viewport` defaults to desktop layout when `mobile` is omitted. `tab.navigate(url, { waitUntil })` passes it through in Code Mode. `ogtool call` and the native `codemode call` now write image blocks such as screenshots to files and print their paths instead of base64 pixels, and `--save-image <path>` saves the single image at an exact path. The browser tool descriptions point agents to Code Mode for repetitive work such as screenshots of many pages.
