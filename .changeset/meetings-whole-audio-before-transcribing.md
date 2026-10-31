---
"@opengeni/react": patch
---

While a meeting is processed, its player waits until every recorded track can play. Before, the microphone could play alone for many minutes while it was transcribed, and a meeting recorded with computer audio sounded as if the call's side was never recorded. The worker now also prepares every track's audio before it transcribes any, so the whole meeting is playable within seconds of the recording ending.
