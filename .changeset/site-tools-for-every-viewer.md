---
"@opengeni/api-router": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/core": patch
---

A Site that uses a connected account now works for everyone who opens it. Publishing a Site that calls the publisher's own account (as an agent sees it) also declares that connector, so another viewer runs the call on their own account, or gets the Connect card when they have none, instead of `API 404: tool_unavailable`. A Site published before this that still points only at another person's account answers with `details.code` `site_tool_not_available_for_viewer` and a message saying to publish it again; the Site receives that code instead of a bare unavailable tool.

Microsoft Dynamics connections are personal by default but can now be shared with the workspace: the connect card offers "This workspace" and the API no longer refuses workspace ownership. Everyone then acts with the sharing person's Dynamics security roles.

The generic Microsoft Dynamics catalog entry now reflects environments already added to the workspace. When one is usable in the chat, `capability_catalog_search` and `capability_authorization_request` report it as ready and name it, instead of asking for an environment address. When the only one still needs the person's sign-in, the request shows that environment's own Connect card.

A Dynamics 365 (Dataverse) or Business Central connector's tool permissions now list the tools agents actually run through Opengeni's Web API bridge, instead of asking the environment's hosted MCP server, which failed with "Could not load the connector's tools" when the environment doesn't allow that MCP client.

The Connect card keeps showing a connection as done after a reload or account switch when the chat already uses it, and setup card results tell the agent the chat continues on its own once the person finishes.

- A prepared key setup (an agent's proposed MCP server) now lets the agent continue the request once it is connected, as other setup cards do.
- A confirmation dialog opened from a form field (such as "Make this person a workspace admin?" in Add people) no longer also submits the form behind it, which added the person with the role chosen before the confirmation.
- When a Site conversation starts waiting for the person, such as an approval from the Site's own `ai.run`, the Site's chat panel opens it.
