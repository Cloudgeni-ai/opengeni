---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A turn started by the platform after an answered turn (a delivered update such as a finished integration setup, or a reply reminder) no longer leaves Claude and similar models with nothing to answer on Responses and Chat routes, such as an organization AI gateway. Those routes moved the update out of the conversation, so the request ended on the model's own earlier reply: Claude read it as an unfinished message and returned an empty response, or continued the old reply. A request-local machine-origin user turn now goes before such a system message, as the native Claude route already did. It applies on every Responses and Chat route, including native OpenAI and Codex Responses; a session whose history already has such a message gets one prompt-cache miss after the update.

A model response with no text and no tool call also no longer makes the turn sample again without end: the run ends at that step, the turn gets one reply reminder, and a second empty response ends it with the visible empty-reply notice. A reasoning-only response that stopped at the output-token limit is still continued, up to three in a row. A streamed Chat response that stopped at the output limit now carries `status: "incomplete"` in its provider data, as Claude responses do, so it reports a `length` finish. `RunAgentStreamOptions` takes an optional `onContentlessModelResponse` callback, and `isContentlessModelResponse`, `stoppedAtOutputLimit` and `ContentlessModelResponseHandover` are exported.
