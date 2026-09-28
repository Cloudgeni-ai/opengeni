import type { ConfirmDependency } from "@/components/ui/destructive-confirm";
import { sessionDisplayTitle } from "@/lib/session-rename";
import type { Rig, ScheduledTask, Session, WorkspaceVariableSet } from "@/types";

/* ----------------------------------------------------------------------------
   Variable sets: what uses a set, and the copy shared by the list, the set's
   own page and its dialogs. Usage is what this browser can see: the first 100
   chats of this workspace, its schedules, and the sandbox environments that
   add the set by default. The server still guards deletion on its own count.
   -------------------------------------------------------------------------- */

export type VariableSetScope = WorkspaceVariableSet["scope"];

export type UsageKind = "schedule" | "chat" | "environment";

export interface UsageEntry {
  id: string;
  kind: UsageKind;
  name: string;
  /** "Schedule", "Chat", "Sandbox environment default". */
  kindLabel: string;
  /** One quiet fact: "Paused", "Added to every new session in this workspace". */
  detail?: string;
  /** Where it lives in the app. */
  href: string;
}

export interface VariableSetUsage {
  /** False while chats or schedules are still loading, or failed to load. */
  known: boolean;
  entries: UsageEntry[];
}

export function sessionUsesVariableSet(
  session: Pick<Session, "variableSetIds" | "variableSetId">,
  variableSetId: string,
): boolean {
  // An advertised plural field is the complete authoritative selection,
  // including an intentionally empty one. Fall back to the singular alias only
  // for sessions returned by older servers that do not advertise the array.
  return session.variableSetIds === undefined
    ? session.variableSetId === variableSetId
    : session.variableSetIds.includes(variableSetId);
}

export function variableSetUsage({
  workspaceId,
  variableSetId,
  sessions,
  tasks,
  rigs,
  defaultRigId,
  known,
}: {
  workspaceId: string;
  variableSetId: string;
  sessions: Session[];
  tasks: ScheduledTask[];
  rigs: Rig[];
  defaultRigId: string | null;
  known: boolean;
}): VariableSetUsage {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const entries: UsageEntry[] = [];
  for (const task of tasks) {
    if (task.variableSetId !== variableSetId) continue;
    entries.push({
      id: `schedule:${task.id}`,
      kind: "schedule",
      name: task.name,
      kindLabel: "Schedule",
      detail: task.status === "paused" ? "Paused" : undefined,
      href: `${base}/schedules?taskId=${encodeURIComponent(task.id)}`,
    });
  }
  for (const session of sessions) {
    if (!sessionUsesVariableSet(session, variableSetId)) continue;
    entries.push({
      id: `chat:${session.id}`,
      kind: "chat",
      name: sessionDisplayTitle(session),
      kindLabel: "Chat",
      href: `${base}/sessions/${encodeURIComponent(session.id)}`,
    });
  }
  for (const rig of rigs) {
    if (!rig.activeVersion?.defaultVariableSetIds.includes(variableSetId)) continue;
    entries.push({
      id: `environment:${rig.id}`,
      kind: "environment",
      name: rig.name,
      kindLabel: "Sandbox environment default",
      detail:
        rig.id === defaultRigId
          ? "Added to every new session in this workspace"
          : "Added to sessions that use this environment",
      href: `${base}/rigs/${encodeURIComponent(rig.id)}`,
    });
  }
  return { known, entries };
}

/* ----------------------------------------------------------------------------
   Copy.
   -------------------------------------------------------------------------- */

/** "A", "A and B", "A, B and C". */
export function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function variablesLabel(set: Pick<WorkspaceVariableSet, "variables">): string {
  return set.variables.length === 0
    ? "No variables"
    : plural(set.variables.length, "variable", "variables");
}

/** ["1 schedule", "2 chats"]: what uses a set, one count per kind. */
export function usageParts(entries: UsageEntry[]): string[] {
  const count = (kind: UsageKind) => entries.filter((entry) => entry.kind === kind).length;
  const parts: string[] = [];
  const schedules = count("schedule");
  const chats = count("chat");
  const environments = count("environment");
  if (schedules) parts.push(plural(schedules, "schedule", "schedules"));
  if (chats) parts.push(plural(chats, "chat", "chats"));
  if (environments) parts.push(plural(environments, "environment", "environments"));
  return parts;
}

/** "1 schedule and 2 chats", or null when nothing uses it. */
export function usageSummary(entries: UsageEntry[]): string | null {
  return entries.length === 0 ? null : joinAnd(usageParts(entries));
}

export const SCOPE_LABEL: Record<VariableSetScope, string> = {
  workspace: "This workspace",
  organization: "Organization",
  user: "Only me",
};

/** The chip next to a name: only for sets that aren't the workspace default. */
export function scopeChip(scope: VariableSetScope): string | null {
  return scope === "workspace" ? null : SCOPE_LABEL[scope];
}

export function scopeHint(scope: VariableSetScope, organizationName: string): string {
  if (scope === "organization") {
    return `Every workspace in ${organizationName} can use it. Only organization admins can change it.`;
  }
  if (scope === "user") {
    return "Only you can use it, in any workspace. Only work you start gets these values.";
  }
  return "Everyone in this workspace can use it in chats and schedules.";
}

export function scopeLocked(scope: VariableSetScope, organizationName: string): string {
  if (scope === "organization") {
    return `Every workspace in ${organizationName} can use it. That was chosen when it was created.`;
  }
  if (scope === "user") return "Only you can use it. That was chosen when it was created.";
  return "Everyone in this workspace can use it. That was chosen when it was created.";
}

const USAGE_PLACE: Record<UsageKind, string> = {
  schedule: "this schedule",
  chat: "this chat",
  environment: "this environment's defaults",
};

/** The blocked delete dialog's one line: what to do before the set can go. */
export function blockedDeleteHint(entries: UsageEntry[]): string {
  const only = entries.length === 1 ? entries[0] : undefined;
  return only
    ? `Remove it from ${USAGE_PLACE[only.kind]} first, then you can delete it.`
    : "Remove it from each of these first, then you can delete it.";
}

export function confirmDependencies(entries: UsageEntry[]): ConfirmDependency[] {
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    kindLabel: entry.kindLabel,
    name: entry.name,
    detail: entry.detail,
    href: entry.href,
  }));
}

/* ----------------------------------------------------------------------------
   Errors: what happened in product words; the reference stays out of the line.
   -------------------------------------------------------------------------- */

export interface ErrorParts {
  message: string;
  status?: number;
  reference?: string;
}

/** Splits "OpenGeni API 409: ... Reference: abc." into its parts. */
export function errorParts(error: unknown): ErrorParts {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const withStatus = error as { status?: unknown; correlationId?: unknown } | null;
  const status = typeof withStatus?.status === "number" ? withStatus.status : undefined;
  let reference =
    typeof withStatus?.correlationId === "string" ? withStatus.correlationId : undefined;
  let message = raw;
  const referenceMatch = / Reference: ([^\s]+?)\.?$/u.exec(message);
  if (referenceMatch) {
    reference ??= referenceMatch[1];
    message = message.slice(0, referenceMatch.index);
  }
  message = message.replace(/^OpenGeni API \d{3}:\s*/u, "").trim();
  if (message && !/[.!?]$/u.test(message)) message = `${message}.`;
  if (message) message = message.charAt(0).toUpperCase() + message.slice(1);
  return { message: message || "Something went wrong. Try again.", status, reference };
}

/** A user-facing error for a form or dialog, keeping the original as its cause. */
export function userFacingError(error: unknown, message = errorParts(error).message): Error {
  return new Error(message, { cause: error });
}
