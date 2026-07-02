// @opengeni/core sandbox-access STRUCTURAL TYPES.
//
// WHY THIS MODULE LIVES IN CORE: `dependencies.ts` (the central deps type
// surface) references the API-tier sandbox-access types — `ApiSandboxClient`,
// `ApiSandboxSession`, `ResumeBoxByIdInput`, `ResumedSandboxSession` — only as
// TYPE slots (the `sandboxClient` / `resumeBoxById` provider seams). Those are
// PURE STRUCTURAL TYPES with no runtime dependency, so they belong in the
// framework-agnostic core alongside the deps types that reference them.
//
// The IMPLEMENTATION that constructs a real sandbox client —
// `createApiSandboxClient`, `makeResumeBoxById`, and the `SandboxResumeError`
// value — stays in `apps/api/src/sandbox/access.ts`, because it imports the
// agent-loop-free `@opengeni/runtime/sandbox` leaf via the API's single import
// chokepoint. apps/api's sandbox/access.ts re-imports these types from here so
// the structural contract has a single owner.
//
// (Mirrors @openai/agents/sandbox's SandboxClient surface without importing the
// agent-loop barrel — see apps/api/src/sandbox/access.ts for the import
// discipline that forbids the bare `@opengeni/runtime` barrel.)

export type ApiSandboxSession = {
  state?: Record<string, unknown> & { sandboxId?: string };
  running?(): Promise<boolean>;
  exec?(args: { cmd: string; workdir?: string; runAs?: string; yieldTimeMs?: number; maxOutputTokens?: number }): Promise<unknown>;
  execCommand?(args: { cmd: string; workdir?: string; runAs?: string; yieldTimeMs?: number; maxOutputTokens?: number }): Promise<string>;
  shutdown?(options?: unknown): Promise<void>;
  delete?(options?: unknown): Promise<void>;
  close?(): Promise<void>;
};

export type ApiSandboxClient = {
  backendId: string;
  deserializeSessionState?(state: Record<string, unknown>): Promise<unknown>;
  resume?(state: unknown, options?: unknown): Promise<ApiSandboxSession>;
  delete?(state: unknown): Promise<void>;
};

export type ResumeBoxByIdInput = {
  /**
   * The backend the box was created on — the lease's `resume_backend_id`. Must
   * match the API's configured sandbox client backendId, or the resume is
   * rejected (a cross-backend envelope can never deserialize correctly).
   */
  backend: string;
  /**
   * The serialized resume-state envelope — the lease's `resume_state` jsonb
   * (the record produced by `client.serializeSessionState(state)`). This is the
   * box identity + reattach descriptor; resume() reattaches to the live box by
   * id (warm reattach) or cold-restores from its snapshot.
   */
  resumeState: Record<string, unknown>;
};

/**
 * A live, resumed sandbox session for a SINGLE in-process op. The caller
 * resumes → uses (exec/readFile/resolvePort) → drops it; lifecycle/refcount is
 * the lease's job (P1.x), NOT this handle's. The session is non-owned by
 * construction (resume-by-id never owns the box), so dropping it does not
 * terminate the box.
 */
export type ResumedSandboxSession = ApiSandboxSession;
