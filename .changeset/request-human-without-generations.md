---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

An agent can now ask a person to act on a browser tab or computer target it has just observed without passing the target's internal generation values. `interaction_request_human` with `operation: "request"` no longer requires `expectedControllerGeneration`, `expectedTargetGeneration` or `expectedDocumentGeneration`; when they are left out, the request is recorded against the target as it is when the turn pauses, and generations the agent does give are still checked.

A request that cannot be recorded (the session or tab is gone or has changed, a given generation no longer matches, the target is unreadable, or another open request already asks a person to act on the same target) no longer fails the turn. Nothing is requested, and the call's result says why and to observe again before asking once more; the turn then continues. `operation: "wait"` for interventions returned by `browser_auth` is unchanged.
