---
"@opengeni/runtime": patch
"@opengeni/codemode": patch
"@opengeni/ogtool": patch
"@opengeni/browserd": patch
---

Make bulk browser work easy to script with Opengeni's own browsers. `navigate` takes an optional `waitUntil` (`load` or `network_idle`), and `viewport` defaults to desktop layout when `mobile` is omitted. `tab.navigate(url, { waitUntil })` passes it through in Code Mode. An explicit `load` wait now waits for the page's load event (images and other subresources finished), not just a parsed document. `ogtool call` and the native `codemode call` now write image blocks such as screenshots to files and print their paths instead of base64 pixels, and `--save-image <path>` saves the single image at an exact path. An existing `--save-image` path is refused before the call; a completed call whose image cannot be saved still prints its result with `imageSaveError` and exits with status 4. Expired temporary image directories are removed only when private and owned by the same user.
