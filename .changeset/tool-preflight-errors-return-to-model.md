---
"@opengeni/runtime": patch
---

A tool call that fails while it is being prepared for approval no longer ends the whole turn with "The session stopped unexpectedly". Before, an error in that step, such as Gmail rejecting a malformed message ID while loading the approval preview, a connector's argument check, or a temporary policy lookup failure, failed the turn and left the call marked as having an unknown outcome even though nothing ran. Now the call returns to the model as an ordinary tool error saying it was not run and nothing was changed, so the model can correct it and continue. Gmail's approval preview also leaves out a message it cannot read for a malformed ID, rate limit or outage instead of refusing the action; authentication and access refusals still stop the call.
