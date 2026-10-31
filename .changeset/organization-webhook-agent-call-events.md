---
"@opengeni/contracts": patch
"@opengeni/db": patch
---

Organization webhooks can subscribe to agent call events (`session.agentCall.ringing` and `session.agentCall.settled`), like the other session events. Before, a create or update naming them passed validation and then failed with an internal error, because the database only allowed them on workspace webhooks. Migration 1211 widens the organization webhook check and trigger; usage events stay workspace-only. The webhook settings page offers the Calls events for organization endpoints too.
