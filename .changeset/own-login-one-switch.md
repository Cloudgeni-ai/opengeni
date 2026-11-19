---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/react": patch
---

Your own connector login now has one switch per workspace. Turning it on in "Where it works" for a workspace that hasn't turned that connector on also turns the connector on there, for each person's own account. This happens in the same request, as the connect card's "Use it here" does it. Where only an admin may turn the connector on, nothing changes: the request is refused with `details.code` `own_login_connector_needs_admin`, and the row says an admin has to turn it on. Turning a login off never turns its connector off.

Each reach row carries an optional `connectorOff` flag. A login that is on where its connector isn't (for example a standing grant) reads as off, with a line saying the switch turns the connector on too. My things doesn't count such a workspace as one where the login works.

The OAuth connect card now offers your one own login first, as "Use my <service> here", without asking "Who can use this connection?". Connecting a new account for everyone stays a secondary choice.
