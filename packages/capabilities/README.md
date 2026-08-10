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
- header, query, and cookie placements are bounded and validated atomically;
- redirects are never followed on credential-bearing requests;
- response bodies, schemas, operation counts, and deadlines are bounded;
- mutating operations are marked approval-required by default;
- a safe read/query may refresh and retry exactly once on `401`, while a
  mutation is never replayed after an ambiguous provider authorization result;
  and
- errors contain structural recovery facts, never provider bodies or secrets.