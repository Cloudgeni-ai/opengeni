---
"@opengeni/react": patch
---

Chat timelines no longer show Claude's web search citation tags as raw text. When Claude writes `<cite index="3-5">quoted claim</cite>` into its answer, the timeline shows only the cited words, also while the answer is still streaming. Ordinary `<cite>` elements and model history are unchanged.
