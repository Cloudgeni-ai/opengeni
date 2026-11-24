---
"@opengeni/runtime": patch
---

The agent is told which message is its reply: text written before a tool call is a progress update, and only the message after its last tool call is the final response, so follow-up tool work such as saving notes comes before the answer. Before, an agent could write its answer, save a note, and end with only a short trailer such as a progress bar; the reply then showed only the trailer, with the answer folded into the work log.
