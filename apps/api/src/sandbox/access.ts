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

// The structural shapes the API needs from a provider sandbox client now live in
// @opengeni/core (`sandbox-types.ts`) — `dependencies.ts` (also in core)
// references them as the `sandboxClient` / `resumeBoxById` provider seams, so
// core is their single owner. We re-export them from here so existing apps/api
// importers (and the `@opengeni/runtime/sandbox` value implementation below)
// keep the same import site. (Mirrors @openai/agents/sandbox's SandboxClient
// without importing the agent-loop barrel.)
export type {
  ApiSandboxSession,
  ApiSandboxClient,
  ResumeBoxByIdInput,
  ResumedSandboxSession,
} from "@opengeni/core";
import type {
  ApiSandboxClient,
  ApiSandboxSession,
  ResumeBoxByIdInput,
  ResumedSandboxSession,
} from "@opengeni/core";

export class SandboxResumeError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
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
export function makeResumeBoxById(
  client: ApiSandboxClient | undefined,
): (input: ResumeBoxByIdInput) => Promise<ResumedSandboxSession> {
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
