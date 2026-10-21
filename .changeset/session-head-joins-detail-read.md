---
"@opengeni/react": patch
---

Opening a conversation reads the session once again. Since the sandbox terminal started reading its own history, `useSessionEvents` read the session's head after its first window to join the live stream there, beside the detail read `useSession` already makes. The head read now joins that detail read when one started since the stream began loading, and reads the session itself only otherwise.
