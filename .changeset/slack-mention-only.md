---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

The Slack bot starts a turn in a channel or channel thread only when it is mentioned; a bot DM still answers every message. An untagged message in a thread that already has an Opengeni session no longer starts a turn or calls Slack: it is only recorded, and the next mention in that thread continues the same session with the untagged messages since the previous invocation attached as model context (`listSlackThreadMessagesSinceLastInvocation`, rolling migration `1013_slack_inbox_thread_context_index`). The exact reply `stop` still pauses a mapped thread with or without a mention. A turn can now end without posting: a final response of exactly `NO_REPLY` settles the Slack task with no message. The Slack session instructions ask for short replies by default, and channel copy (hint, failure, billing and input prompts, the reaction start line and `info` card) says to mention Opengeni to continue. No setting existed for the previous answer-every-thread-reply behavior, so none is kept.
