---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Show a failed turn's error once, in the failed banner next to Retry. The work header says only "Failed", an attempt replaced by Retry becomes a quiet "Attempt failed · retried" row with its text behind the disclosure, and the "failed" and "work resumed" dividers no longer repeat a turn's own failure. The banner keeps the full recorded text behind Details. Without a banner, the turn's row or the failure's own notice shows the text once.
