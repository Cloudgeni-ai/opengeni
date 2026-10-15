---
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

Show a turn that must compact its context before its first model request as a calm "Compacting conversation first" step instead of a red "Runtime/model preparation failed" row. The worker records that step as an expected transition, then reopens model preparation for the retried request so its real dispatch is recorded and timed on its own. Compaction raised at stream entry no longer leaves a duplicate running preparation row. Earlier session events are unchanged.
