---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

A chat waiting for Codex subscription capacity now waits honestly and wakes on real capacity. Before a waiting turn is judged, the waiter re-reads both usage and every account's live model list, so it judges the same pool the resumed turn will be placed on: it no longer resumes a turn only to have it park again a second later, and the expected time it names is the reset of an account that actually offers the turn's model (and latency tier), or no time at all when none is known. A waiting turn no longer fails after ten resumptions with text only an operator could act on; it keeps waiting, with the existing backoff between resumptions. The chat and the inbox notification now say the message will be answered as soon as there is room, and that switching to another model continues sooner.
