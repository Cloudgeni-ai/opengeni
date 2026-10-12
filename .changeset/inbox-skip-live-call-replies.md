---
"@opengeni/db": patch
---

Replies during a live voice call no longer land in the inbox or alert the phone. While a session has an active voice call, each finished turn is spoken back in the call, so it doesn't refresh the session's kept reply or send a "replied" push. A reply that finishes after the call has ended still arrives as before.
