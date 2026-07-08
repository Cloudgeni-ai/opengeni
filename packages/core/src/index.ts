// @opengeni/core — the framework-agnostic OpenGeni core.
//
// WHAT THIS PACKAGE IS: the OpenGeni domain, access, and billing layers carved
// out of `apps/api` into an importable library, so a host (e.g. cloudgeni) can
// call the OpenGeni core DIRECTLY, off-HTTP — e.g. `createSessionForRequest(
// deps, grant, workspaceId, input)` — without standing up the Hono router.
// `apps/api` (@opengeni/api-router) and `apps/worker` (@opengeni/worker-bundle)
// remain the STANDALONE RUNNERS that consume this library; nothing about the
// standalone served API or the worker boot changed.
//
// BEHAVIOR-PRESERVING MOVE PASS (Chunk 3): this extraction is a pure file-move +
// import-rewrite with ZERO behavior change. The domain keeps throwing Hono
// `HTTPException` exactly as before — so `hono` is a real runtime dependency of
// @opengeni/core for now. The typed-errors carve-out (transport-neutral error
// hierarchy + HTTP adapter in the router) is DEFERRED to a later pass; there is
// no `errors.ts` here yet.
//
// DEPENDENCY DISCIPLINE: the moved closure references the engine-internal
// sandbox client (`@opengeni/runtime/sandbox`, via the fleet/routing service it
// needs for `swapActiveSandbox`) and the type slots
// `@opengeni/storage`/`documents`/`observability` (in `dependencies.ts`). The
// storage/documents/observability references are TYPE-ONLY (erased at build),
// so they are devDependencies. `@opengeni/runtime` and `@opengeni/codex` are
// real runtime deps (fleet routing + the codex model-id prefix constant). The
// Better Auth `Auth` type (`managed-auth-type.ts`) is a type-only devDependency.

// The central dependency type surface (AppDependencies, ApiRouteDeps,
// SessionWorkflowClient, DocumentIndexClient, ObjectStorageDependency).
export * from "./dependencies";

// Boundary type slots referenced by dependencies.ts. The IMPLEMENTATIONS that
// construct these (the real sandbox client / Better Auth instance) stay in
// apps/api because they pull engine-internal / driver packages; only the
// structural TYPES live here.
export * from "./sandbox-types";
export * from "./managed-auth-type";

// Sandbox fleet/routing service — the closure of `domain/sessions.ts`
// (`swapActiveSandbox` + `FleetContext`). apps/api re-imports these for its MCP
// fleet tools, the machines REST route, and the rest of the sandbox layer.
export * from "./sandbox/fleet";
export * from "./sandbox/routing";

// Access layer (transport-neutral grant resolution + permission checks).
export * from "./access";

// Billing / usage-limit admission (checkLimit / requireLimit / recordWorkspaceUsage).
export * from "./billing/limits";

// Domain layer — the off-HTTP V2 surface (createSessionForRequest,
// postUserMessageTurn, createAndStartSession, capability/pack/environment/
// scheduled-task/workspace-member logic, …).
export * from "./domain/capabilities";
export * from "./domain/environments";
export * from "./rigs";
export * from "./domain/packs";
export * from "./domain/resources";
export * from "./domain/scheduled-tasks";
export * from "./domain/sessions";
export * from "./domain/workspace-members";
