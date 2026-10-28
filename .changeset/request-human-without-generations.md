---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

An agent can now ask a person to act on a browser tab or computer target it has just observed without passing the target's internal generation values. `interaction_request_human` with `operation: "request"` no longer requires `expectedControllerGeneration`, `expectedTargetGeneration` or `expectedDocumentGeneration`.

When the turn pauses, every request without an `authRunId` reads its target as it is then. Generations left out are taken from that reading; generations given must equal it, or the request is refused. If the target cannot be read, a request that gives all three is recorded as given, and one that leaves any out is refused. A request with an `authRunId` takes and checks its generations against that auth run instead. In every case the controller generation is checked against the live browser or computer session.

A call that cannot be recorded (the session or tab is gone or has changed, a given generation does not match, the target is unreadable, the auth run does not match, another open request already asks a person to act on the same target, including one opened at the same moment, or an `operation: "wait"` for an intervention that is not open or not this turn's) no longer fails the turn. Nothing is written for it, and the call's result says in plain words why and what to do next: observe again and ask again, leave the expected generation fields out, or wait for the request `browser_auth` returned. Each refused call gets its own result. A pause resumes on one answer at a time, so when several calls of one step are refused, the turn resumes on the first refusal and the next is refused when the turn pauses again. Refused requests are not counted as opened in the intervention metric.
