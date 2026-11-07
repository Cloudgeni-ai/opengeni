---
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

When a chat's own model cannot summarize older history, the turn no longer fails with "start a new session". On an OpenAI-compatible endpoint, a summary request rejected with HTTP 400 or 422 is first sent once more without its output cap, and a summary from that retry is held to the cap by cutting it from the middle. If the summary still fails in a way that repeating it cannot fix (a definitive rejection, a non-temporary failed response, or an empty or unusable summary, including one cut off at the output limit), the history is trimmed instead: platform context and the newest requests are kept as a summarized checkpoint keeps them, and a fixed note stands in for the summary. No other model is asked, so no history leaves the chat's provider. Retryable, temporary, transport, authentication and quota failures, cancellation, Codex remote compaction and the rebuild when a Codex chat switches model keep their existing handling, with history unchanged. The provider's own error message, bounded, is now recorded in the structured `providerMessage` field of the session's events (the trimmed checkpoint's `fallback`, the `summarization_failed` skip and `turn.failed`), never in free-text errors or worker logs. The timeline shows "Older messages trimmed" with the provider's reason behind Details.
