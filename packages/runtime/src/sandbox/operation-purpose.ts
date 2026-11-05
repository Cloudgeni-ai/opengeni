import { AsyncLocalStorage } from "node:async_hooks";
import { SandboxWorkspaceReadNotFoundError } from "@openai/agents/sandbox";
import { SandboxFilesystemNotFoundError } from "modal";
import { isDefinitePathNotFoundError } from "./channel-a";

/**
 * Platform-internal reasons for sandbox provider operations. Setup work runs
 * on the raw provider session, outside the routed SDK veneer and its
 * operation metric, so without this scope the time spent before the first
 * model request is attributable only as one opaque setup interval.
 *
 * The set stays closed so metric labels remain bounded. Lifecycle hooks report
 * under their own hook ids, which are also a closed built-in set.
 */
export const SANDBOX_OPERATION_PURPOSES = [
  "hook.artifact-runtime-doctor",
  "hook.azure-cli-login",
  "hook.codemode-client",
  "hook.codemode-token",
  "hook.codemode-token-renewal-registration",
  "hook.git-credential-renewal-registration",
  "hook.repository-clone",
  "hook.repository-removal",
  "hook.rig-setup",
  "hook.other",
  "run_credentials",
  "file_resources",
  "lazy_manifest",
  "repository_skills",
  "box_repair",
] as const;

export type SandboxOperationPurpose = (typeof SANDBOX_OPERATION_PURPOSES)[number];

const PURPOSES = new Set<string>(SANDBOX_OPERATION_PURPOSES);

type PurposeScope = { purpose: SandboxOperationPurpose; measuring: boolean };

const scope = new AsyncLocalStorage<PurposeScope>();

/** Bounded purpose for a lifecycle hook id; unknown ids collapse to `hook.other`. */
export function sandboxHookOperationPurpose(hookId: string): SandboxOperationPurpose {
  const purpose = `hook.${hookId}`;
  return PURPOSES.has(purpose) ? (purpose as SandboxOperationPurpose) : "hook.other";
}

/** Attribute every provider operation started inside `fn` to `purpose`. The
 * innermost scope wins, so credential writes issued by a hook report as
 * credentials rather than as the hook. */
export function withSandboxOperationPurpose<T>(
  purpose: SandboxOperationPurpose,
  fn: () => Promise<T>,
): Promise<T> {
  return scope.run({ purpose, measuring: false }, fn);
}

export function currentSandboxOperationPurpose(): SandboxOperationPurpose | undefined {
  return scope.getStore()?.purpose;
}

export type SandboxSetupOperationObservation = {
  backend: string;
  op: string;
  purpose: SandboxOperationPurpose;
  /** `not_found` is a read-only probe's definite "no such path" answer, such as
   * repository skill discovery listing an absent `.agents/skills`. The
   * provider answered; the caller expects and handles the miss. */
  outcome: "completed" | "not_found" | "failed";
  durationSeconds: number;
};

const INSTRUMENTED_OPERATIONS = [
  "exec",
  "execCommand",
  "readFile",
  "writeFile",
  "listDir",
  "pathExists",
  "materializeEntry",
] as const;

const READ_ONLY_PATH_PROBES = new Set<string>(["readFile", "listDir", "pathExists", "viewImage"]);

/** A definite path miss is the provider's authoritative answer to a read-only
 * probe (repository skill discovery lists absent `.agents/skills` on almost
 * every turn), not a failed provider operation. Writes never qualify. Only
 * typed or errno-coded misses count, the same set skill discovery treats as
 * absent: generic 404 statuses or "not found" prose (for example a vanished
 * sandbox) never do. Shared by this setup metric and the routed per-operation
 * metric. The setup metric's `purpose` label tells callers apart: a miss is
 * expected for skill discovery, but may matter for another purpose. */
export function isReadOnlyPathProbeMiss(op: string, error: unknown): boolean {
  return (
    READ_ONLY_PATH_PROBES.has(op) &&
    (isDefinitePathNotFoundError(error) ||
      error instanceof SandboxWorkspaceReadNotFoundError ||
      error instanceof SandboxFilesystemNotFoundError)
  );
}

const instrumented = new WeakSet<object>();

/**
 * Measure provider operations issued inside a purpose scope, in place, so the
 * session keeps its identity (callers compare and memoize session objects).
 * Operations outside any scope, such as model tool calls that the routed
 * veneer already measures, are not observed here. An operation implemented
 * through another instrumented method of the same session counts once.
 */
export function instrumentSandboxSessionOperations<T>(
  session: T,
  backend: string,
  observe: (observation: SandboxSetupOperationObservation) => void,
): T {
  if (!session || typeof session !== "object" || instrumented.has(session)) return session;
  instrumented.add(session);
  const target = session as Record<string, unknown>;
  for (const op of INSTRUMENTED_OPERATIONS) {
    const original = target[op];
    if (typeof original !== "function") continue;
    const bound = (original as (...args: unknown[]) => unknown).bind(session);
    target[op] = function instrumentedSandboxOperation(...args: unknown[]): unknown {
      const active = scope.getStore();
      if (!active || active.measuring) return bound(...args);
      const startedAt = performance.now();
      let outcome: SandboxSetupOperationObservation["outcome"] = "failed";
      return scope.run({ purpose: active.purpose, measuring: true }, async () => {
        try {
          const result = await bound(...args);
          outcome = "completed";
          return result;
        } catch (error) {
          try {
            if (isReadOnlyPathProbeMiss(op, error)) outcome = "not_found";
          } catch {
            // Classification is telemetry only.
          }
          throw error;
        } finally {
          try {
            observe({
              backend,
              op,
              purpose: active.purpose,
              outcome,
              durationSeconds: Math.max(0, performance.now() - startedAt) / 1_000,
            });
          } catch {
            // Telemetry never changes provider behavior.
          }
        }
      });
    };
  }
  return session;
}

/** Every raw provider client method that returns a new live session. Modal
 * creates production boxes through `createWithLifecycle`, so wrapping only
 * `create` would leave every fresh Modal box unmeasured. */
const SESSION_RETURNING_CLIENT_METHODS = [
  "create",
  "createWithLifecycle",
  "resume",
  "resumeExact",
] as const;

/** Sessions the raw provider client creates or resumes report the operations
 * issued inside a setup purpose scope. Patch before the exact-resume contract
 * freezes `resumeExact`, so its ordinary delegation also returns measured
 * sessions. Session identity is unchanged. */
export function instrumentSandboxClientSessionOperations(
  raw: unknown,
  backend: string,
  observe: (observation: SandboxSetupOperationObservation) => void,
): void {
  if (!raw || typeof raw !== "object") return;
  const client = raw as Record<string, unknown>;
  for (const method of SESSION_RETURNING_CLIENT_METHODS) {
    const original = client[method];
    if (typeof original !== "function") continue;
    const descriptor = Object.getOwnPropertyDescriptor(client, method);
    if (descriptor && descriptor.writable === false) continue;
    const bound = (original as (...args: unknown[]) => Promise<unknown>).bind(raw);
    client[method] = async (...args: unknown[]) =>
      instrumentSandboxSessionOperations(await bound(...args), backend, observe);
  }
}
