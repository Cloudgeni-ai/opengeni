---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A move to another machine that the running turn attempt cannot serve (another workspace root, or a home it cannot reach) now ends the attempt cleanly between tool batches, before the model is asked for its next step. Previously the next batch's first sandbox call failed the attempt, discarding that whole model response, including sibling calls that had already run. A sandbox call in the same batch as the move that is refused before it reaches any machine now returns a result saying it did not start, so every call in the batch has a certain outcome.
