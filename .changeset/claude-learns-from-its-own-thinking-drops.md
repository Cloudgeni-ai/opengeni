---
"@opengeni/runtime": patch
---

Claude thinking that Claude drops itself now converges to readable text. When a Claude response reports that it dropped replayed thinking blocks because their prefix no longer matched (`thinking_dropped` with `prefix_binding_mismatch`, under `drop_block`), Opengeni remembers those blocks, every signed block after them, and the response's own thinking, so the next request sends them as readable historical reasoning instead of having Claude drop them, and all later thinking, on every request. Blocks Claude drops only because the model or account cannot read them are not prefix edits and stay native, as Anthropic recommends. The binding recorded on Claude thinking for prefix-bound models now also covers the request's tools, so a tools change between turns sends earlier turns' thinking as text directly; the reply in progress stays native unless Claude drops it. Thinking recorded under the previous binding (without tools) is sent as text once.
