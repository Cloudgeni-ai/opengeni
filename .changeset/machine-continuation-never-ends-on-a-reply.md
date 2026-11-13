---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A turn started by the platform after an answered turn (a delivered update such as a finished integration setup, or a reply reminder) no longer leaves Claude and similar models with nothing to answer on Responses and Chat routes, such as an organization AI gateway. Those routes moved the update out of the conversation, so the request ended on the model's own earlier reply: Claude read it as an unfinished message and returned an empty response, or continued the old reply. A request-local machine-origin user turn now goes before such a system message, as the native Claude route already did. A model response with no text and no tool call also no longer makes the turn sample the same request again without end: the run ends at that step, the turn gets one reply reminder, and a second empty response ends it with the visible empty-reply notice. `RunAgentStreamOptions` takes an optional `onContentlessModelResponse` callback, and `isContentlessModelResponse` and `ContentlessModelResponseHandover` are exported.
