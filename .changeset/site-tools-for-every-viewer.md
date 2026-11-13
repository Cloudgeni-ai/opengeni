---
"@opengeni/api-router": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/core": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
---

A Site that uses a connected account now works for everyone who opens it. Publishing a Site that calls the publisher's own account (as an agent sees it) also declares that connector, so another viewer runs the call on their own account, or gets the Connect card when they have none, instead of `API 404: tool_unavailable`. A Site published before this that still points only at another person's account answers with `details.code` `site_tool_not_available_for_viewer` and a message saying to publish it again; the Site receives that code instead of a bare unavailable tool.

For an agent, the publisher's accounts are its turn's own account routes, and the publication accepts the connector declared alongside each of them. A retry with the tools as originally declared replays the same publication. A list that pairing would push past the 128-tool limit is refused with a message, instead of being left working only for the publisher.

When a Site's tool call can't complete, the viewer now sees a clear state in the Opengeni frame instead of a raw error such as `API 404: tool_unavailable`, and the Site receives a typed `code` it can read: Reconnect for an account whose sign-in stopped working (`site_tool_reconnect_required`, signing in to that same account, personal or shared; a call Opengeni refused before sending it then runs again, while a provider's result asking to sign in again is returned for the Site to call again), a plain refusal that names the system for a provider's permission error (`site_tool_permission_denied`, e.g. "Microsoft Dynamics didn't allow this for your account."), a message asking the Site owner to publish again (`site_tool_not_available_for_viewer`), and a readable message for anything else (`site_tool_unavailable`). Try again is offered only when Opengeni confirms the call ran nothing and the refusal isn't definitive, and it reuses the same operation id. A dropped connection, a 5xx or an untyped error on a call may have run, so it says to check before trying again (`site_tool_outcome_unknown`) and is never run again. The original error stays behind Details. Calls that fail the same way at once share one message. `createSiteToolBridge` takes `recoverToolCall` for this host UI and exports `SiteToolCallFailedError`; Site consent accounts carry the viewer's `connectionId`, `capabilityId` and whether it is `shared`; a tool call that needs its connection signed in again carries `structuredContent.error.code` `connection_auth_needed`, and the Dynamics bridge marks Microsoft's permission refusals `provider_permission_denied`.

For Site authors: a failed `site.tools` call now rejects with one of the `site_tool_*` codes above. The original code (`not_found`, `upstream_unavailable`, `tool_connection_needs_attention`, ...) stays readable on `error.details.code`. A provider's error result is unchanged (its `content` and `structuredContent.error`) and gains `structuredContent.siteToolFailure` with the typed code and the viewer's sentence. `OpenGeniSiteBridgeError` has an optional `details`.

Microsoft Dynamics connections are personal by default but can now be shared with the workspace: the connect card offers "This workspace" and the API no longer refuses workspace ownership. Everyone then acts with the sharing person's Dynamics security roles.

The generic Microsoft Dynamics catalog entry now reflects environments already added to the workspace. When one is usable in the chat, `capability_catalog_search` and `capability_authorization_request` report it as ready and name it, instead of asking for an environment address. When the only one still needs the person's sign-in, the request shows that environment's own Connect card.

A Dynamics 365 (Dataverse) or Business Central connector's tool permissions now list the tools agents actually run through Opengeni's Web API bridge, instead of asking the environment's hosted MCP server, which failed with "Could not load the connector's tools" when the environment doesn't allow that MCP client.

The Connect card keeps showing a connection as done after a reload or account switch when the chat already uses it, and setup card results tell the agent the chat continues on its own once the person finishes.

- A prepared key setup (an agent's proposed MCP server) now lets the agent continue the request once it is connected, as other setup cards do.
- A confirmation dialog opened from a form field (such as "Make this person a workspace admin?" in Add people) no longer also submits the form behind it, which added the person with the role chosen before the confirmation.
- When a Site conversation starts waiting for the person, such as an approval from the Site's own `ai.run`, the Site's chat panel opens it.
