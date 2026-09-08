# Isolation and authorization

## Start from who may share, not from workspace count

An OpenGeni organization is the administrative and billing container. An organization workspace is the operational boundary for sessions, events, files, documents, connections, installed capabilities, workspace Memory, settings, and agent access.

Use the smallest group allowed to share those workspace-scoped capabilities as the workspace mapping unit:

| Product requirement | Default mapping | Why |
| --- | --- | --- |
| A team or tenant may collaborate across all chats | One workspace per team or tenant | Shared sessions and workspace resources match the product rule |
| Each end user's chats are private from other end users, but that user's chats may share context or agent authority | One workspace per end user | Other users are outside the workspace boundary |
| Every chat must be isolated, including from the same user's other chats | One workspace per chat | Session separation alone is not the current hard agent boundary |
| Chats may share but data access differs by tenant | At least one workspace per data tenant | Provider authority must never span a tenant that may not share data |
| Different users access the same data but their chats are private | Separate user or chat workspaces, each with suitable data authority | Shared upstream data does not weaken the conversation boundary |

Other mappings are valid when the product explicitly accepts their sharing semantics. Document that decision; do not use workspace count alone as an optimization goal.

A workspace is control-plane state, not a dedicated cluster or permanently running sandbox. Creating one adds database/configuration state and may require repeated capability or Connection provisioning, but compute is established for sessions when needed. Hundreds of workspaces are not inherently exceptional. Per-chat workspaces have more lifecycle and connector-management overhead, so automate reconciliation and deletion instead of weakening a hard privacy requirement.

## Current session authority facts

- A top-level session created by an organization API key defaults to workspace visibility.
- Managed-human private or Only-me sessions require the exact supported managed-cookie human path and organization activation. They are not available merely because a backend includes an external user ID.
- A live agent attempt with the relevant first-party session tools and permissions can read, message, or control unrelated sessions in the same workspace. Parent/child lineage is not the general access boundary.
- Workspace Memory controls retrieval and saving of workspace facts. Turning it off does not remove session history, change session visibility, or neutralize cross-session tools.
- Hiding session-list and session-get alone is incomplete. Events, waiting, messaging, control, discovery, workspace Memory, documents, notes, or other workspace-wide tools may still cross the intended boundary.

If the requirement is a hard boundary, use workspaces. If a customer deliberately accepts a softer same-workspace boundary, remove every unnecessary peer-session and workspace-wide capability as defense in depth and test the exact live tool catalog. Describe the remaining risk honestly.

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

For a softer same-workspace design, add an explicit regression test over the effective tool policy. Treat that as defense in depth, not proof of database isolation.
