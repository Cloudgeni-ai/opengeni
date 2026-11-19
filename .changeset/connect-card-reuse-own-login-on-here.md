---
"@opengeni/react": patch
---

The Connect card for an OAuth MCP connector that isn't set up in this workspace yet now offers your one own login for it ("Use it here") even when that login is already turned on here. Using it sets the connector up for each person's own account and turns the login on here only when it is off, so no new sign-in is needed. For connectors that share one workspace connection by default, in a workspace with other people, the card still asks who can use the connection first, and offers your login once you choose "Only me".
