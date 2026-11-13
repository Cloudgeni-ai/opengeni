---
"@opengeni/api-router": patch
"@opengeni/sdk": patch
---

A Site that uses a connected account now works for everyone who opens it. Publishing a Site that calls the publisher's own account (as an agent sees it) also declares that connector, so another viewer runs the call on their own account, or gets the Connect card when they have none, instead of `API 404: tool_unavailable`. A Site published before this that still points only at another person's account answers with `details.code` `site_tool_not_available_for_viewer` and a message saying to publish it again; the Site receives that code instead of a bare unavailable tool.
