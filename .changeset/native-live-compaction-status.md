---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

The mobile chat now shows "Compacting conversation history…" while a compaction runs, then its outcome when it settles, worded like the web chat and in the app's language. It used to show a fixed English "context compacted" from the moment a compaction started, so a long summary request (often a minute or more on a long chat) looked like it had already finished while the turn sat silent. The web and mobile rows now share one `compactionRowCopy` from `@opengeni/react/timeline-model`.
