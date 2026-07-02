---
"@opengeni/react": patch
---

First paint of a session is now a single compact fetch (deeper history loads via the scroll sentinel), and the hook exposes `initialLoading` so hosts can suppress genesis fallbacks while the tail window is still fetching — on large sessions the web console painted the session's initial message at the top for the whole fetch.
