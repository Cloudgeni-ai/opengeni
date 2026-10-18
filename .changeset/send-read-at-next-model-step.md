---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

A message sent to a busy chat no longer waits for the whole running turn, which can last hours. Before each model request, after the previous step's tool results are saved, the worker checks whether a person's prompt (human or API Send) is queued behind the turn. If so, it sends no request and ends the turn as `superseded` with reason `queued_prompt`; the queued message runs next on the unchanged history, so the agent reads it within one model step. A tool call in progress is never cut off (Steer still interrupts immediately). The settlement re-checks the queue under the session lock, so a message withdrawn in between leaves the turn working. The timeline closes a handed-over turn quietly instead of as interrupted, and the send button's tooltip now says a busy agent reads the message after its current step.
