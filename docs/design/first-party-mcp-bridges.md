# First-party local MCP bridge contract

Status: implemented contract; provider adapters remain independently reviewed.

A first-party local MCP bridge presents a provider API as an in-process
`MCPServer`. It lets the ordinary runtime catalog, lazy tool discovery, session
tool policy, approvals, connector-action policy, Codemode projection, and
cleanup lifecycle treat provider-authored and OpenGeni-authored MCP surfaces
the same way. It is an execution adapter, not a new Connection, OAuth, catalog,
or UI subsystem.

The code contract is `packages/capabilities/src/mcp-bridge.ts`:

- every server exposes a validated, secret-free `LocalMcpBridgeDescriptor`;
- a static reviewed bridge declares `toolSurface: "static_reviewed"`; a
  compiled Integration Definition declares `"immutable_revision"`;
- `authority` names the existing authority spine (`connection`, `host`, or
  `none`) but never grants it;
- every provider destination is an exact HTTPS origin plus path prefix;
- `mutationReplay: "safe_reads_only"` is mandatory: a safe read may refresh
  and retry after an authorization failure, while a mutation with an ambiguous
  provider outcome is never replayed; and
- adapter selection is exact. Zero matches uses the ordinary remote MCP path;
  multiple matches fail closed instead of silently replacing one provider
  route.

`packages/runtime/src/index.ts` owns the built-in adapter registry. A provider
matcher and factory live with their adapter, not in generic catalog, OAuth, or
UI code. Persisted API Integrations already enter through
`LocalMcpServerRegistration`; their OpenAPI server implements the same bridge
descriptor without changing the Integration Definition or Connection
authority.

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
6. Register the adapter in the built-in registry or return its server through
   the existing API Integration registration seam. No second transport or tool
   registry is introduced.

## Current providers and corrected OPE-266 scope

- **Gmail** is the static reviewed example. Its catalog identity remains the
  official Gmail MCP resource, while every call executes through
  `GmailRestMcpServer` and the existing personal Connection resolver.
- **Google Drive** already uses the immutable Integration Definition compiler
  and local OpenAPI MCP adapter. It now explicitly conforms to this contract;
  its provider-specific facet/source authority and one Integration row remain
  unchanged. A duplicate Connector row would be incorrect.
- **Square Cash App** already has a streamable-HTTP provider endpoint in the
  committed catalog (`https://connect.squareup.com/v2/mcp/cash-app`). It needs
  no local bridge. A broader Square bridge requires a separately reviewed tool
  surface and product identity; the old SSE premise is not current.
- **GitHub** retains its host-owned GitHub App installation and repository
  allowlist authority. It is deliberately not converted into a Connection or
  duplicate catalog Connector by this contract.

### Proposed GitHub bridge follow-up

Keep the existing single GitHub Integration row and owner-consent flow. Add one
host-authority local bridge that mints a short-lived installation token only
after rechecking the exact live workspace binding and selected repository for
each call. The first reviewed surface should be:

- reads: repository list, issue get/list, pull-request get/list, file get, and
  code search;
- writes: issue create/comment and pull-request create/comment;
- every write remains approval-gated and uses a caller operation identity when
  GitHub exposes a safe idempotency/reconciliation seam; otherwise an ambiguous
  provider outcome is reported and never replayed.

The bridge should require `github:use`, keep installation tokens host-only, and
remain absent from generic Connection/OAuth resolution. Repository identity
must be one of the binding's current durable allowlist entries before token
mint or provider I/O. Expanding this surface, especially reviews, merges,
workflow dispatch, branch mutation, or repository administration, needs a
separate safety and approval review.
