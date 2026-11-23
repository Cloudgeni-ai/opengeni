---
"@opengeni/react": patch
---

The browser viewer no longer shows a frozen picture as live. A live view whose connection stays open but stops sending frames for 15 seconds opens a new stream; after the automatic retries it says the browser stopped sending its picture and offers to reconnect.
