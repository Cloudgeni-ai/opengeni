# @opengeni/core

`@opengeni/core` is the extracted OpenGeni server core: domain flows, access checks, billing/admission helpers, sandbox fleet/routing helpers, and the shared dependency types that HTTP routes and embedded hosts use.

It owns code that is not intrinsically HTTP or Temporal process bootstrapping:

- access: `requireAccessContext`, `requireAccessGrant`, `requirePermission`
- domain: session creation/follow-up, scheduled-task validation, environments, packs, capabilities, workspace members
- billing/admission: `checkLimit`, `requireLimit`, `recordWorkspaceUsage`
- dependencies: `AppDependencies`, `ApiRouteDeps`, `SessionWorkflowClient`

`@opengeni/api-router` owns the Hono app, middleware, HTTP route adapters, MCP HTTP transport, and API-direct sandbox endpoints. `@opengeni/worker-bundle` owns Temporal worker construction, workflows, activities, and process lifecycle. Both consume `@opengeni/core`; core does not import either app.

The package is used by standalone OpenGeni through those app runners and by embedded hosts that call core directly or mount the API router.

## Scope honesty: engine-core, not domain-core

This package is the **engine core** — the transport-mostly-neutral heart of the
server, extracted so embedders can mount it. It still carries server-flavored
dependencies (notably Hono's `HTTPException` as the domain error type and the
full persistence/runtime closure). It is NOT a pure domain library and does not
try to be one; if you need OpenGeni without any server runtime, you want the
REST API + `@opengeni/sdk` instead.
