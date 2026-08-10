# `@opengeni/capabilities`

Protocol-neutral integration compilation for OpenGeni. Immutable OpenAPI and
GraphQL revisions are compiled into local `MCPServer` implementations so they
use the existing lazy tool router, session policy, approval, auth-needed,
Toolspace, child-session, and scheduled-task paths.

The package owns protocol parsing and invocation only. Connection persistence,
credential encryption, tenant authority, operation receipts, and catalog
lifecycle stay in OpenGeni's core/database layers.

Security defaults:

- credentials are resolved for one exact destination and verified before use;
- redirects are never followed on credential-bearing requests;
- response bodies, schemas, operation counts, and deadlines are bounded;
- mutating operations are marked approval-required by default;
- a 401/403 after a request starts is never replayed automatically; and
- errors contain structural recovery facts, never provider bodies or secrets.