---
"@opengeni/react": patch
---

Keep the workbench's initial tab unresolved while a signed capture manifest is loading, so pending capture metadata cannot permanently select Files instead of Changes. Preserve host overrides, settled empty/error fallbacks, and the user's later tab selection.