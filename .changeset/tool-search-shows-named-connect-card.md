---
"@opengeni/runtime": patch
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": patch
---

`tool_search` now shows an integration's Connect card itself when a search clearly names one integration the person can connect (exactly one named, by a distinctive mention such as "on Slack", "ClickUp" or "Airtabel"), instead of relying on the agent to call `capability_authorization_request` next. It posts the card through that same tool when the search call is accepted, with the same authorization, tool selection and policy, and does not post it again until the person writes (a first-connection card never stands in for a reconnect card); the search result then says the card is shown. Model calls of the tool are unchanged. Searches naming several integrations, an installed one, or a name used as an ordinary word keep today's notice, as does any search where the card tool answers without a card; when the card call fails or times out, the notice no longer says whether a card was shown.

Whether a card is in the chat is now stated in every result: `tool_search` results that name a connectable integration carry `connectCard` (`shown`, and when shown its `capabilityId`, `eventId` and `alreadyShown`), and every `capability_authorization_request` result carries `cardShown` (and `alreadyShown` for a repeat from search). `@opengeni/contracts` exports `TOOL_DISCOVERY_CARD_META_KEY`, the request `_meta` key that marks a card request from tool discovery, and `@opengeni/db`'s `appendTurnCapabilityCardOnce` takes an optional `{ sinceLatestMessage }` to reuse a card any turn shows since the person's latest message, and now reuses only a card of the same kind (a first connection, or a reconnect of the same connection).
