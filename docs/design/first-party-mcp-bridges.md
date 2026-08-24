# First-party local MCP bridge contract

Status: implemented contract; provider adapters remain independently reviewed.

A first-party local MCP bridge presents a provider API as an in-process
`MCPServer`. It lets the ordinary runtime catalog, lazy tool discovery, session
tool policy, approvals, connector-action policy, Codemode projection, and
cleanup lifecycle treat provider-authored and OpenGeni-authored MCP surfaces
the same way. It is an execution adapter, not a new Connection, OAuth, catalog,
or UI subsystem.

The code contract is `packages/capabilities/src/mcp-bridge.ts`:

- every conforming bridge server exposes a validated, secret-free
  `LocalMcpBridgeDescriptor` and declares `toolSurface: "static_reviewed"`;
- `authority` names the existing authority spine (`connection`, `host`, or
  `none`) but never grants it;
- every bridge declares 1-32 exact HTTPS origins plus path prefixes;
- `mutationReplay: "safe_reads_only"` is mandatory: a safe read may refresh
  and retry after an authorization failure, while a mutation with an ambiguous
  provider outcome is never replayed; and
- adapter selection is exact. Zero matches uses the ordinary remote MCP path;
  multiple matches fail closed instead of silently replacing one provider
  route.

`packages/runtime/src/index.ts` owns the built-in adapter registry. A provider
matcher and factory live with their adapter, not in generic catalog, OAuth, or
UI code. Existing OpenAPI and GraphQL Integration Definitions continue through
their ordinary local MCP adapters and do not claim this reviewed static bridge
descriptor. Compiler-wide OpenAPI destination governance remains separate work.

## Adding a bridge

1. Keep the provider's catalog identity, curation, presentation, and OAuth
   profile in their existing data models. Do not add a provider branch to the
   importer, generic OAuth client/profiles, or row/sheet components.
2. Reuse an existing Connection or host-owned authority. Revalidate it before
   every physical provider request. Never copy credentials into MCP schemas,
   tool results, events, model context, sandbox environment, or the descriptor.
3. Publish a bounded, deterministic tool list. Classify writes and destructive
   operations for the ordinary approval and connector-action policy paths.
4. Pin provider destinations and bounded response/deadline behavior. Reject
   credential-bearing redirects.
5. Prove safe-read refresh and mutation outcome-unknown behavior in tests.
6. Register the adapter in the built-in registry. No second transport or tool
   registry is introduced.

## Current provider scope

- **Gmail** is the static reviewed example. Its catalog identity remains the
  official Gmail MCP resource, while every call executes through
  `GmailRestMcpServer` and the existing personal Connection resolver.
- **Google Drive** already uses the immutable Integration Definition compiler
  and local OpenAPI MCP adapter. It remains functional as one Integration row
  with its provider-specific facet/source authority unchanged, but does not
  claim the new static bridge descriptor. A duplicate Connector row would be
  incorrect.
- **Square Cash App** already has a streamable-HTTP provider endpoint in the
  committed catalog (`https://connect.squareup.com/v2/mcp/cash-app`). It needs
  no local bridge. A broader Square bridge requires a separately reviewed tool
  surface and product identity; the old SSE premise is not current.
- **GitHub** uses one static-reviewed `GitHubRestMcpServer` protocol bridge with
  two non-substitutable worker authority adapters: the workspace GitHub App
  acts as the OpenGeni bot, while personal OAuth acts as the exact connected
  user. The default-off `OPENGENI_GITHUB_REST_MCP_ENABLED` flag adds the
  resource-backed namespaces only when an accepted turn carries matching
  repositories. Arguments can select only `owner/name` from that private
  accepted set; they cannot select a connection or actor. Every physical API
  request revalidates the current installation/Connection and repository row.
  Reads cover repositories, branches/refs, files, issues, pull requests,
  checks/status, and bounded code search. Reviewed writes cover branch/ref,
  issue, pull-request, comment, and review-request creation/update only. Missing
  write policy defaults to Ask; explicit Allow/Ask/Block remains attempt-frozen
  for model and Codemode calls. Mutations are never replayed after an ambiguous
  provider outcome. Merge, force-push, ref deletion, releases, workflows,
  administration, and other unreviewed mutations are absent.
