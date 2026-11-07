---
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

When a chat's own model cannot summarize older history, the turn no longer fails with "start a new session". On an OpenAI-compatible endpoint, a summary request rejected with HTTP 400 or 422 is first sent once more without its output cap. If the summary still fails terminally, the history is trimmed instead: platform context and the newest requests are kept as a summarized checkpoint keeps them, and a fixed note stands in for the summary. No other model is asked, so no history leaves the chat's provider. Retryable failures, exhausted quotas, cancellation and Codex remote compaction keep their existing handling. The provider's own error message, bounded, is now recorded on the session's events (`providerMessage` on the trimmed checkpoint's `fallback`, the `summarization_failed` skip and `turn.failed`); worker logs stay content-free. The timeline shows "Older messages trimmed" with the provider's reason behind Details.
