---
"@opengeni/sdk": minor
"@opengeni/api-router": patch
"@opengeni/runtime": patch
"@opengeni/site-gateway": patch
---

Site tools now run on a person's own account that was added in another workspace and turned on here ("Use it here"), the same account a chat in this workspace uses. Before, the Site's tool gateway read that credential in the current workspace, found nothing, and the call failed with `tool_unavailable`.

When the provider can't read what an action would do because the account must allow more access, the confirmation now answers 409 with `details.code` `tool_connection_needs_more_access` (with the connection and scopes) instead of a generic 422; signing in again answers `tool_connection_needs_attention`, and a provider refusal for that account answers 403 `tool_unavailable_for_account`. Site code receives the new typed code `site_tool_grant_required`, or `site_tool_reconnect_required` and `site_tool_permission_denied`.
