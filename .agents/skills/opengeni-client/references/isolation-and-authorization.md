# Isolation and authorization

## Start from who may share, not from workspace count

An OpenGeni organization is the administrative and billing container. An organization workspace is the operational boundary for sessions, events, files, documents, connections, installed capabilities, workspace Memory, settings, and agent access.

Use the smallest group allowed to share those workspace-scoped capabilities as the workspace mapping unit:

| Product requirement | Default mapping | Why |
| --- | --- | --- |
| A team or tenant may collaborate across all chats | One workspace per team or tenant | Shared sessions and workspace resources match the product rule |
| Users share workspace resources but their conversations are private | One workspace per tenant; `asUser()` and private session visibility | Canonical ownership protects transcripts without duplicating shared resources |
| An agent must not reach even its user's other conversations | `agentAccess: "session"` | An additional task-tree boundary, independent of human visibility |
| Chats may share but data access differs by tenant | At least one workspace per data tenant | Provider authority must never span a tenant that may not share data |
| Different users access the same data but their chats are private | Shared workspace data and private sessions | Shared upstream data does not make a private transcript shared |

Other mappings are valid when the product explicitly accepts their sharing semantics. Document that decision; do not use workspace count alone as an optimization goal.

A workspace is control-plane state, not a dedicated cluster or permanently running sandbox. Creating one adds database/configuration state and may require repeated capability or Connection provisioning, but compute is established for sessions when needed. Hundreds of workspaces are not inherently exceptional. Per-chat workspaces have more lifecycle and connector-management overhead, so automate reconciliation and deletion instead of weakening a hard privacy requirement.

## Current session authority facts

- A top-level session created by an organization API key defaults to workspace visibility.
- Private or Only-me sessions require verified owning-user authority and organization activation. Native managed sessions and the server-side `asUser()` path establish that authority; a raw `endUser` payload does not.
- An agent must pass ordinary permissions and private-session ownership checks. The caller's `agentAccess` narrows outbound reach: `session` stays in its root tree; `user` requires matching non-null canonical scope users across trees; `workspace` adds no further restriction. The target's `agentAccess` never restricts inbound access. None of these modes overrides private visibility.
- Workspace Memory controls retrieval and saving of workspace facts. Turning it off does not remove session history, change session visibility, or neutralize cross-session tools.
- Hiding session-list and session-get alone is incomplete. Events, waiting, messaging, control, discovery, workspace Memory, documents, notes, or other workspace-wide tools may still cross the intended boundary.

One workspace per end user or One workspace per chat remains possible when the
resources and integration configuration themselves must be isolated, but is not
required merely to make a conversation private. Use the canonical private
session boundary for transcripts; choose separate workspaces for workspace
resources. Remove unnecessary tools as defense in depth, never as a substitute
for either boundary. User Memory follows the verified active-turn user; task
notes cover task-local coordination. Session-scoped Memory is retired without
promoting historical rows into workspace visibility.

## Explicit headless tool policy

For a customer-facing headless session, never rely accidentally on omission:

- Omitting tools uses the workspace's configured MCP defaults; an explicit empty tools list suppresses them.
- Omitting firstPartyMcpTools selects the deployment's non-connector default catalog; an explicit empty list exposes none.
- Build an allowlist from the product's actual use case and the live SDK type or client configuration.
- Exclude cross-session tools unless collaboration is an explicit feature. Current examples include sessions_list, session_get, session_events, session_wait, session_send_message, session_pause, session_resume, session_steer, session_human_input_respond, set_other_session_title, and workspace-scoped discovery. Recheck the live catalog rather than treating this list as permanent.
- Also examine Memory, knowledge, notes, files, artifacts, browsers, computers, scheduling, and capability-management tools. A tool is safe only when both its scope and its necessity fit the product.
- A tool allowlist narrows what the model can invoke; it does not repair an incorrectly shared workspace, an over-broad provider token, or a vulnerable customer API.

## Backend mapping pattern

The product backend should:

1. Authenticate the product request using the product's existing identity system.
2. Derive the canonical sharing boundary from trusted server-side identity, such as tenant ID, user ID, or conversation ID.
3. Resolve or lazily ensure the corresponding organization workspace with a stable externalSource plus externalId pair.
4. Persist the returned opaque workspace ID with the product boundary record.
5. Resolve the product's own session-to-OpenGeni-session mapping before every read, stream, message, control, or upload operation.
6. Reject caller-supplied OpenGeni workspace or session IDs that do not match those mappings.

The externalId passed to `ensureWorkspace` identifies the product boundary; it does not create an OpenGeni human. A service-mode integration need not create one OpenGeni account or workspace membership per end user. External user mode is distinct: `asUser` lazily resolves an organization-scoped external identity, and shared access requires explicit membership intersected with the initiating key's permissions. See [External users and Connect](external-users-and-connect.md) for onboarding and current limitations. Provision workspaces lazily on first use, from a product lifecycle event, or through a controlled backfill according to operational needs. The ensure call is idempotent and should use the same identity on retries.

An organization API key is intentionally broad across organization workspaces. Keep it in the backend secret manager. Where a component needs only one workspace, consider a narrower workspace key. In either case the customer's backend remains responsible for mapping its authenticated principal to the correct OpenGeni boundary.

## Isolation verification

Include negative tests, not only a successful chat:

- User A cannot open, stream, message, or attach a file to user B's mapped session through product routes.
- A manipulated browser request carrying another workspace or session ID is rejected before the OpenGeni call.
- A prompt that names or guesses another session cannot make the agent retrieve it with the selected tools.
- Workspaces created concurrently for the same boundary converge on one mapping; distinct boundary IDs never converge.
- Provider credentials and API tools cannot request another tenant merely by changing a request argument.
- Deleting or disabling a product user applies the customer's chosen session/workspace retention and access policy.

For same-workspace private sessions, verify ownership through HTTP, tools,
lists and streams; also verify optional agent reach independently. Test the
effective tool policy as defense in depth, not as proof of ownership enforcement.
