---
"@opengeni/react": patch
---

Opening a conversation reads the session once again. Since the sandbox terminal started reading its own history, `useSessionEvents` reads the session's head to join the live stream there, a second read of the detail `useSession` already reads fresh. The head read now joins that detail read when one started since the stream began loading, and reads the session itself only otherwise.
