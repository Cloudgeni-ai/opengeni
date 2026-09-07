---
"@opengeni/api-router": patch
---

Allow session_get to omit sessionId only for the authenticated current agent session, preserving live-attempt and target authorization. Sessionless callers still require an explicit ID; compact and full results remain bounded.