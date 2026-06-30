// Pure state + payload mapping for the rich create-session form (sandbox
// backend, environment attach, goal, first-party MCP permission scope).
import { sessionMcpPermissionGroups } from "@/lib/permissions";
import type { GoalSpec, SandboxBackend, TurnSubmission } from "@/types";

export type AdvancedSessionDraft = {
  // The enrolled selfhosted machine (a sandbox id) to seed the session's active
  // sandbox at create — `null` runs on the default cloud sandbox. This is NOT a
  // TurnSubmission extra: it's a top-level CreateSessionRequest field, threaded
  // separately into `startSession` (see `targetSandboxIdFromAdvancedSessionDraft`).
  targetSandboxId: string | null;
  // The targeted machine's working directory — the path/cwd base its agent exec,
  // terminal, and file dock run under. Free-form pass-through: a launch-
  // workspace_root-relative subdir or an absolute machine path. Empty (the
  // default) ⇒ the machine's default workspace_root (byte-identical to today).
  // Only meaningful WITH `targetSandboxId`; like it, a top-level
  // CreateSessionRequest field threaded into `startSession` separately.
  workingDir: string;
  sandboxBackend: SandboxBackend | "";
  environmentId: string;
  goalText: string;
  goalSuccessCriteria: string;
  goalMaxAutoContinuations: string;
  customMcpPermissions: boolean;
  mcpPermissions: Set<string>;
};

export function emptyAdvancedSessionDraft(): AdvancedSessionDraft {
  return {
    targetSandboxId: null,
    workingDir: "",
    sandboxBackend: "",
    environmentId: "",
    goalText: "",
    goalSuccessCriteria: "",
    goalMaxAutoContinuations: "",
    customMcpPermissions: false,
    mcpPermissions: new Set(sessionMcpPermissionGroups.flatMap((group) => group.permissions)),
  };
}

/** The picked machine's sandbox id (the top-level create field), or null for the
 *  default cloud sandbox. Threaded into `startSession` separately from the
 *  TurnSubmission extras. */
export function targetSandboxIdFromAdvancedSessionDraft(draft: AdvancedSessionDraft): string | null {
  return draft.targetSandboxId;
}

/** The picked machine's working directory (the top-level create field), or null
 *  for the machine's default workspace_root. Like the target sandbox id, threaded
 *  into `startSession` separately from the TurnSubmission extras. A blank/whitespace
 *  value normalizes to null (omitted ⇒ no-op default). */
export function workingDirFromAdvancedSessionDraft(draft: AdvancedSessionDraft): string | null {
  return draft.workingDir.trim() || null;
}

/** The create-session payload extras from the advanced options card. */
export function submissionExtrasFromAdvancedSessionDraft(draft: AdvancedSessionDraft): Omit<TurnSubmission, "text"> {
  const maxAutoContinuations = nonNegativeInteger(draft.goalMaxAutoContinuations);
  const goal: GoalSpec | null = draft.goalText.trim()
    ? {
        text: draft.goalText.trim(),
        ...(draft.goalSuccessCriteria.trim() ? { successCriteria: draft.goalSuccessCriteria.trim() } : {}),
        ...(maxAutoContinuations !== null ? { maxAutoContinuations } : {}),
      }
    : null;
  return {
    ...(draft.sandboxBackend ? { sandboxBackend: draft.sandboxBackend } : {}),
    ...(draft.environmentId ? { environmentId: draft.environmentId } : {}),
    ...(goal ? { goal } : {}),
    ...(draft.customMcpPermissions ? { firstPartyMcpPermissions: [...draft.mcpPermissions] } : {}),
  };
}

function nonNegativeInteger(value: string): number | null {
  const parsed = Number(value);
  return value.trim() && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
