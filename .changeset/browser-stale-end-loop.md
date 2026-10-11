---
"@opengeni/react": patch
---

The browser viewer no longer loops on ending a lost attached-device browser. A refusal (4xx) is not retried, and transient failures retry at most three times with backoff; previously a 409 was re-sent on every registry refresh, about one request per second.
