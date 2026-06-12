// Pure state + payload mapping for the rich create-session form (sandbox
// backend, environment attach, goal, first-party MCP permission scope).
import { sessionMcpPermissionGroups } from "@/lib/permissions";
import type { GoalSpec, SandboxBackend, TurnSubmission } from "@/types";

export type AdvancedSessionDraft = {
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
    sandboxBackend: "",
    environmentId: "",
    goalText: "",
    goalSuccessCriteria: "",
    goalMaxAutoContinuations: "",
    customMcpPermissions: false,
    mcpPermissions: new Set(sessionMcpPermissionGroups.flatMap((group) => group.permissions)),
  };
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
