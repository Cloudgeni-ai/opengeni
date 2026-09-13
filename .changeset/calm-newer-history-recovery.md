---
"@opengeni/react": patch
---

Preserve the current history window when loading later activity fails, expose the original error, and offer explicit timeline retry without repeated observer requests. Ignore late failures from a previous session or navigation lifetime.