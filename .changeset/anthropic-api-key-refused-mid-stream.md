---
"@opengeni/runtime": patch
---

An organization's pooled Anthropic API key that Anthropic refuses for lack of credits after its response has begun streaming now moves the request to the chat's next key, the same as a refusal before the stream. Anthropic reports such a refusal as an error event inside an HTTP 200 stream, which previously failed the turn with `anthropic_stream_error` and left the key unmarked, so later turns kept trying it. The key is now marked out of credits and the same request is sent again on the next key, including while continuing a paused response. The turn fails only when no key with credits remains. A connection with a single key fails as before.
