---
"@opengeni/react": patch
---

`useBrowserSession` no longer keeps polling a tab's observation after the server refuses it for good (a non-retryable 4xx, such as a tab Chrome won't let the browser extension control). The poll skips that page until the tab shows another document or address, or an observation made for a person's input succeeds. Failures that may pass, such as a busy controller, are still retried.
