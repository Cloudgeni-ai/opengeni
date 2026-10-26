---
"@opengeni/runtime": patch
---

Opening a browser linked to a ComputerSession that does not exist now lists this chat's open ComputerSessions, as other missing-session refusals do: detection recognises the API's "Linked ComputerSession not found". A session that was listed as open a moment ago but is now missing is described as having just ended.
