---
---

Make the Northstar demo safe to run as an anonymous public site: each browser gets a signed visitor cookie and reaches only the agent sessions it started through `authorizeSession`; sessions are private, session-scoped, Knowledge-free, and usage-limited; unused proxy surfaces (session list, archive, model selection, files, voice, realtime) are off; and agent runs and resets are rate-limited. The panel no longer promises a per-turn model picker.
