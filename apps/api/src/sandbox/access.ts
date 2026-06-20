// apps/api/src/sandbox/access.ts — the API-tier sandbox access seam.
//
// This is the foundation of the API-DIRECT control plane
// (docs/design/sandbox-surfacing): the apps/api process constructs its OWN
// sandbox client and resumes boxes by id IN-PROCESS, so non-turn ops (viewer
// attach, FS/git reads, tunnel URL mint) never touch Temporal or a worker.
//
// IMPORT DISCIPLINE (enforced by apps/api/test/sandbox-access-import-guard.test.ts):
//   apps/api accesses sandbox construction/resume symbols ONLY via the
//   agent-loop-free leaf `@opengeni/runtime/sandbox` — NEVER the bare
//   `@opengeni/runtime` barrel (which pulls the @openai/agents agent loop into
//   the API process). This file is the single chokepoint for that import.
import { createSandboxClient } from "@opengeni/runtime/sandbox";
import type { Settings } from "@opengeni/config";

// The structural shape the API needs from a provider sandbox client. The leaf's
// createSandboxClient returns `unknown` (it is provider-polymorphic); we narrow
// to exactly the methods the API-direct control plane uses — resume-by-id and
// the deserialize step that turns a stored resume_state envelope back into a
// live SandboxSessionState. (Mirrors @openai/agents/sandbox's SandboxClient
// without importing the agent-loop barrel.)
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

export class SandboxResumeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SandboxResumeError";
  }
}

/**
 * Construct the API process's own sandbox client from settings, agent-loop-free.
 * Returns undefined when `sandboxBackend=none` (no box to touch). The Modal
 * token + app name are read from settings (already parsed by getSettings and
 * present in the API runtime env), so the client can resume Modal boxes by id.
 */
export function createApiSandboxClient(settings: Settings): ApiSandboxClient | undefined {
  const client = createSandboxClient(settings) as ApiSandboxClient | undefined;
  return client;
}

/**
 * Build the `resumeBoxById` helper bound to the API's sandbox client. Given a
 * backend + a serialized resume_state envelope, it resumes the box and returns
 * a live session for one in-process op. The caller drives exec/readFile and then
 * drops the handle (resume → use → drop); it does NOT own the box.
 */
export function makeResumeBoxById(client: ApiSandboxClient | undefined): (input: ResumeBoxByIdInput) => Promise<ResumedSandboxSession> {
  return async ({ backend, resumeState }: ResumeBoxByIdInput): Promise<ResumedSandboxSession> => {
    if (!client) {
      throw new SandboxResumeError(
        "The API sandbox client is not configured (sandboxBackend=none); cannot resume a box by id.",
      );
    }
    if (client.backendId !== backend) {
      throw new SandboxResumeError(
        `Resume backend "${backend}" does not match the API sandbox client backend "${client.backendId}"; a cross-backend resume_state envelope cannot be deserialized.`,
      );
    }
    if (!client.deserializeSessionState || !client.resume) {
      throw new SandboxResumeError(
        `The configured sandbox backend "${client.backendId}" does not support resume-by-id (no deserializeSessionState/resume).`,
      );
    }
    let session: ApiSandboxSession;
    try {
      const state = await client.deserializeSessionState(resumeState);
      session = await client.resume(state);
    } catch (error) {
      throw new SandboxResumeError(
        `Failed to resume sandbox box by id on backend "${backend}": ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    return session;
  };
}
