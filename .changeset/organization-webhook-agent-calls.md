---
"@opengeni/db": patch
---

Organization webhooks can subscribe to `session.agentCall.ringing` and `session.agentCall.settled`, as workspace webhooks already could. The API accepted these types for organization endpoints, but the database refused them and the request failed with an internal error, so a product serving many workspaces from one organization endpoint never heard a call ring. Existing registrations are unchanged until they add the types.
