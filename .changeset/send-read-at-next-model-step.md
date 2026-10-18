---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

A message sent to a busy chat no longer waits for the whole running turn, which can last hours. Before each model request after the turn's first response, the worker checks whether a person's prompt (human or API Send) is queued behind the turn. If so, and the turn owns no running process that ending it would stop, it sends no request: the run finishes cleanly at that step boundary (the new `ModelStepHandover` from `@opengeni/runtime`, handled by the run's error handlers so every event of the finished step is delivered) and the turn ends as `superseded` with reason `queued_prompt`. The queued message runs next on the unchanged history, so the agent reads it within one model step, and every queued prompt gets at least one model step of its own. A tool call in progress is never cut off (Steer still interrupts immediately). The settlement re-checks the queue under the session lock, so a message withdrawn in between leaves the turn working. The timeline closes a handed-over turn quietly instead of as interrupted, and the send button's tooltip now says a busy agent reads the message after its current step.
