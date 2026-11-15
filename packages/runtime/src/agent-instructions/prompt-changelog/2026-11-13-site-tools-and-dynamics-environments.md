# Site tool misses and the generic Microsoft Dynamics entry state facts

There are no changes to system-prompt or tool-description text. Only tool and API results change, and only in the cases below: about +150 to +400 bytes per affected result, and nothing otherwise.

A Site tool call on another member's account route that the Site version
doesn't pair with its connector used to fail with a bare `tool_unavailable`.
It now answers `details.code` `site_tool_not_available_for_viewer` with a
message that the Site must be published again (the Site runtime and the
agent read it).

The generic `api:microsoft-dynamics` catalog entry used to ask for an
environment address even when the workspace already had a connected
environment, so agents told people Dynamics wasn't connected. Its setup and
its `capability_authorization_request` result now name the existing
environments (name, address, capabilityId) and state their status, generated
from the catalog:

```text
+ Already connected and usable in this chat: <environments>. Use its tools. Only for a different environment: <unchanged address guidance>
+ This workspace already has <environments>. Call capability_authorization_request with this capabilityId; its card signs them in without asking for the address. Only for a different environment: <unchanged address guidance>
+ This workspace already has <environments>, but it is not usable in this chat: <that environment's own setup detail> Only for a different environment: <unchanged address guidance>
```

When exactly one environment still needs the caller's sign-in, the request
shows that environment's own card instead of `input_required`. Without
environments, the text is unchanged.

An MCP tool result that needs its connection signed in again keeps its text
and now also carries `structuredContent.error` with `code`
`connection_auth_needed` (about +120 bytes). The Dynamics Web API bridge's
error results for Microsoft's permission refusals carry `code`
`provider_permission_denied`, and its sign-in refusals `connection_auth_needed`,
beside the same message. Hosts such as the Site frame read the code; the text
the model reads is unchanged.
