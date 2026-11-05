/**
 * Platform setup that fails softly.
 *
 * Every turn re-runs platform setup on a warm box: the Codemode client and its
 * token under /workspace/.opengeni, credential hooks, repository clones. The
 * agent can leave its own box in a state where one of those writes fails, for
 * example by filling /workspace. The box's snapshot keeps that state, so a
 * hard failure would fail every later turn before the model could repair it.
 *
 * A hook failure the box itself caused (no space, a read-only or blocked path,
 * denied permission, a setup command that exited non-zero) therefore no longer
 * fails the turn. The turn starts and the model is told which step failed and
 * why, once, through the shared setup notices (sandbox-setup-notices.ts).
 * Everything else keeps failing setup as before, so the worker's
 * recovery still sees it: a cancelled or fenced attempt, an unanswered or
 * replaced machine agent, a machine that cannot start programs, a timed-out
 * command, and any failure without a recognised cause.
 */
import type { SandboxLifecycleHook } from "./index";
import { isSandboxLifecycleCommandExitError } from "./sandbox/lifecycle-command-error";
import { isMachineProcessStartFailureMessage } from "./sandbox/selfhosted/process-start-failure";

/** One platform setup step that failed softly this turn. */
export type SoftSetupFailure = {
  hookId: string;
  cause: SoftSetupFailureCause;
};

export type SoftSetupFailureCause =
  | { kind: "no_space" }
  | { kind: "quota" }
  | { kind: "read_only" }
  | { kind: "permission_denied" }
  | { kind: "path_blocked" }
  | { kind: "command_failed"; exitCode: number };

/** The platform hooks whose failure leaves the box usable. Rig setup runs the
 * rig author's own script and is not one of them. */
const SOFT_FAILABLE_HOOKS: Record<string, { what: string; after: string }> = {
  "codemode-client": {
    what: "Opengeni tools in the shell (ogtool and the Codemode client) were not installed",
    after: "they are installed again at the start of the next turn",
  },
  "codemode-token": {
    what: "The Opengeni tools sign-in for the shell was not saved, so ogtool calls can fail",
    after: "it is saved again at the start of the next turn",
  },
  "repository-clone": {
    what: "Repository setup did not finish, so a repository or its Git credentials can be missing or out of date",
    after: "repository setup runs again at the start of the next turn",
  },
  "azure-cli-login": {
    what: "The Azure CLI sign-in did not finish",
    after: "it runs again at the start of the next turn",
  },
  "run-credentials": {
    what: "Connected-account credentials for the shell were not written, so commands that use them can fail",
    after: "they are written again at the start of the next turn",
  },
  "artifact-runtime-doctor": {
    what: "The document and spreadsheet tools check did not finish, so those tools can fail",
    after: "it runs again at the start of the next turn",
  },
};

/** Whether a failure of this hook may let the turn start with a notice. */
export function isSoftFailableSetupHook(hookId: string): boolean {
  return Object.hasOwn(SOFT_FAILABLE_HOOKS, hookId);
}

const MAX_GRAPH_NODES = 64;

/** Every Error in the cause graph (`cause`, the SDK's `.error`, members). */
function errorGraph(error: unknown): Error[] {
  const found: Error[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  try {
    for (let index = 0; index < queue.length && seen.size < MAX_GRAPH_NODES; index += 1) {
      const node = queue[index];
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (node instanceof Error) found.push(node);
      const record = node as { cause?: unknown; error?: unknown; errors?: unknown };
      queue.push(record.cause, record.error);
      if (Array.isArray(record.errors)) queue.push(...record.errors.slice(0, 16));
    }
  } catch {
    // An unreadable graph keeps what was read so far.
  }
  return found;
}

const STOPPED_ATTEMPT_ERROR_NAMES = new Set([
  "AbortError",
  "CancelledFailure",
  "TurnAttemptFencedError",
  "TurnOperationCancelledError",
  "TurnSandboxCommandCancelledError",
]);

/** A Modal exec whose program could not be loaded: every Opengeni command
 * starts /bin/sh, so the box cannot start programs at all. Matched with or
 * without Modal's "in sandbox:" prefix, which sanitized copies drop. */
const MODAL_SHELL_LOAD_FAILURE = /\bfailed to load \/bin\/sh\b/;

/** A lifecycle command still running at its bound (the box may be stuck). */
const LIFECYCLE_COMMAND_TIMEOUT = /did not finish before the lifecycle command timeout/;

/**
 * Whether the failure must keep failing setup: the attempt stopped, the
 * machine agent did not answer or was replaced, the machine cannot start
 * programs, or a command did not finish. The worker recovers these.
 */
function isHardSetupFailure(nodes: Error[]): boolean {
  for (const node of nodes) {
    if (STOPPED_ATTEMPT_ERROR_NAMES.has(node.name)) return true;
    if (node.name === "SelfhostedControlError") {
      const control = node as Error & Record<string, unknown>;
      if (
        control.processStartFailed === true ||
        control.agentOffline === true ||
        control.connectionReplaced === true ||
        control.draining === true ||
        control.fenced === true ||
        control.reason === "agent_offline" ||
        control.reason === "agent_reconnecting"
      ) {
        return true;
      }
    }
    const texts = [typeof node.message === "string" ? node.message : ""];
    if (isSandboxLifecycleCommandExitError(node)) texts.push(node.output);
    for (const text of texts) {
      if (
        isMachineProcessStartFailureMessage(text) ||
        MODAL_SHELL_LOAD_FAILURE.test(text) ||
        LIFECYCLE_COMMAND_TIMEOUT.test(text)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Causes that only the box's own disk produces. Any error that names one of
 * these is the box's state, whichever step reported it.
 */
const DISK_CAUSES: Array<{ pattern: RegExp; cause: SoftSetupFailureCause }> = [
  { pattern: /no space left on device|\bENOSPC\b|os error 28\b/i, cause: { kind: "no_space" } },
  { pattern: /disk quota exceeded|\bEDQUOT\b|os error 122\b/i, cause: { kind: "quota" } },
  { pattern: /read-only file system|\bEROFS\b|os error 30\b/i, cause: { kind: "read_only" } },
];

/**
 * Causes whose words also appear in failures that are not the box's files
 * ("Permission denied (publickey)" from git, an API's "file exists"). They
 * count only where a file operation in the box reported them.
 */
const PATH_CAUSES: Array<{ pattern: RegExp; cause: SoftSetupFailureCause }> = [
  {
    pattern: /permission denied|operation not permitted|\bEACCES\b|\bEPERM\b|os error 13\b/i,
    cause: { kind: "permission_denied" },
  },
  {
    pattern: /not a directory|is a directory|file exists|\bENOTDIR\b|\bEISDIR\b|\bEEXIST\b/i,
    cause: { kind: "path_blocked" },
  },
];

/** Hooks whose commands only write Opengeni's own files under /workspace, so
 * a path cause in their output is about those files. (The document tools
 * check reads the image's tools, so its output is not about /workspace.) */
const FILE_WRITING_COMMAND_HOOKS = new Set(["codemode-client", "codemode-token"]);

/** Box paths whose file errors the model can fix. */
const BOX_PATH = /^\/(?:workspace|tmp)(?:\/|$)/;

/**
 * A file operation's own error on the box: a provider filesystem error, or a
 * Node errno error for a path under /workspace or /tmp. A worker-local file
 * error (for example reading a shipped asset) is not the box's state.
 */
function isFileOperationError(node: Error): boolean {
  if (/Filesystem|FileSystem/.test(node.name)) return true;
  const errno = node as Error & { code?: unknown; syscall?: unknown; path?: unknown };
  return (
    typeof errno.code === "string" &&
    typeof errno.syscall === "string" &&
    typeof errno.path === "string" &&
    BOX_PATH.test(errno.path)
  );
}

/**
 * The SDK's remote path probe (`<provider> failed to check path <path>`)
 * exits 2, without a diagnostic, when a parent of the path exists but is not
 * a searchable folder: for example /workspace/.opengeni replaced by a file.
 * The probe itself ran, so the box works.
 */
function isBlockedPathProbe(node: Error): boolean {
  if (!/ failed to check path /.test(String(node.message ?? ""))) return false;
  const details = (node as Error & { details?: unknown }).details;
  if (!details || typeof details !== "object") return false;
  const { status, signal, timedOut } = details as Record<string, unknown>;
  return status === 2 && !signal && timedOut !== true;
}

function nodeTexts(node: Error): string[] {
  const texts = [String(node.message ?? "")];
  if (isSandboxLifecycleCommandExitError(node) && node.output) texts.push(node.output);
  return texts;
}

/**
 * The cause of a platform setup hook failure that leaves the box usable, or
 * null when the failure must keep failing setup. `hookId` names the hook that
 * failed: what its error text means depends on what the hook does.
 */
export function softSetupFailureCause(
  error: unknown,
  hookId?: string,
): SoftSetupFailureCause | null {
  const nodes = errorGraph(error);
  if (nodes.length === 0 || isHardSetupFailure(nodes)) return null;
  const allText = nodes.flatMap(nodeTexts).join("\n");
  for (const { pattern, cause } of DISK_CAUSES) {
    if (pattern.test(allText)) return cause;
  }
  const pathText = nodes
    .filter(
      (node) =>
        isFileOperationError(node) ||
        (isSandboxLifecycleCommandExitError(node) &&
          hookId !== undefined &&
          FILE_WRITING_COMMAND_HOOKS.has(hookId)),
    )
    .flatMap(nodeTexts)
    .join("\n");
  for (const { pattern, cause } of PATH_CAUSES) {
    if (pattern.test(pathText)) return cause;
  }
  if (nodes.some(isBlockedPathProbe)) return { kind: "path_blocked" };
  const exit = nodes.find(isSandboxLifecycleCommandExitError);
  if (exit) return { kind: "command_failed", exitCode: exit.exitCode };
  return null;
}

/** What to try when a hook's own command failed, by hook. */
const COMMAND_FAILED_FIX: Record<string, string> = {
  "repository-clone": "Run the git clone or git fetch for the repository yourself to see the error",
  "azure-cli-login": "Run az login yourself to see the error",
  "artifact-runtime-doctor":
    "Check that the document tools (for example LibreOffice and Python) are still installed and run",
};

/**
 * A failure to write this turn's run credential files that the box's own disk
 * caused (full, over quota, read-only), or null. The worker writes those files
 * before the hooks; any other failure keeps failing setup.
 */
export function softRunCredentialWriteFailure(error: unknown): SoftSetupFailure | null {
  const cause = softSetupFailureCause(error, "run-credentials");
  if (!cause || !["no_space", "quota", "read_only"].includes(cause.kind)) return null;
  return { hookId: "run-credentials", cause };
}

function causeText(cause: SoftSetupFailureCause, hookId: string): { reason: string; fix: string } {
  switch (cause.kind) {
    case "no_space":
      return {
        reason: "No space left on the workspace machine's disk",
        fix: "Free space in /workspace or /tmp (for example large build outputs, caches or downloads)",
      };
    case "quota":
      return {
        reason: "The workspace machine's disk quota is used up",
        fix: "Free space in /workspace or /tmp",
      };
    case "read_only":
      return {
        reason: "The file system is read-only",
        fix: "Make /workspace writable again",
      };
    case "permission_denied":
      return {
        reason: "Permission was denied",
        fix: "Restore write access to /workspace and /workspace/.opengeni",
      };
    case "path_blocked":
      return {
        reason: "A path is blocked by a file or folder of the wrong kind",
        fix: "Move or delete what is in the way under /workspace/.opengeni or the repository folder",
      };
    case "command_failed":
      return {
        reason: `Its setup command exited with code ${cause.exitCode}`,
        fix: COMMAND_FAILED_FIX[hookId] ?? "Check that /workspace is writable and has free space",
      };
  }
}

/** How every soft setup failure notice starts. */
export const SOFT_SETUP_FAILURE_NOTICE_PREFIX = "Platform setup notice:";

/** The model-visible notice for this turn's soft setup failures, or "" when none. */
export function softSetupFailureNotice(failures: readonly SoftSetupFailure[]): string {
  if (failures.length === 0) return "";
  const lines = failures.map(({ hookId, cause }) => {
    const hook = SOFT_FAILABLE_HOOKS[hookId] ?? {
      what: `Platform setup step ${hookId} did not finish`,
      after: "it runs again at the start of the next turn",
    };
    const { reason, fix } = causeText(cause, hookId);
    return `- ${hook.what}. ${reason}. ${fix}; then ${hook.after}.`;
  });
  return [
    `${SOFT_SETUP_FAILURE_NOTICE_PREFIX} part of this workspace machine's setup failed, and the turn continued without it.`,
    ...lines,
  ].join("\n");
}

/**
 * The hooks, with each soft-failable hook's recognised failures recorded in
 * `failures` instead of thrown. Other hooks, and other failures, are unchanged.
 */
export function softFailingSetupHooks(
  hooks: readonly SandboxLifecycleHook[],
  failures: SoftSetupFailure[],
  observe?: (failure: SoftSetupFailure, error: unknown) => void,
): SandboxLifecycleHook[] {
  // Independent hooks finish in any order; the notice keeps declaration order.
  const order = (failure: SoftSetupFailure) =>
    hooks.findIndex((hook) => hook.id === failure.hookId);
  return hooks.map((hook) => {
    if (!isSoftFailableSetupHook(hook.id)) return hook;
    return {
      ...hook,
      run: async (session, context) => {
        try {
          await hook.run(session, context);
        } catch (error) {
          const cause = softSetupFailureCause(error, hook.id);
          if (!cause) throw error;
          const failure = { hookId: hook.id, cause };
          failures.push(failure);
          failures.sort((left, right) => order(left) - order(right));
          observe?.(failure, error);
        }
      },
    };
  });
}
