import type { SandboxItem, StartupPhaseItem, WorkerItem } from "./types";
import { type OpenGeniText } from "../messages/runtime";

/* Pure titles and durations for platform activity rows (startup phases and
   sandbox operations), shared by DOM and non-DOM renderers. */

export function sandboxRowTitle(
  t: OpenGeniText,
  item: SandboxItem,
  displayName: (name: string) => string,
): string {
  if (item.name === "sandbox.provision") {
    return startupPhaseTitle(
      t,
      "sandbox",
      item.status === "cancelled" ? "complete" : item.status,
      item.origin ?? null,
    );
  }
  return displayName(item.name);
}

export function startupPhaseTitle(
  t: OpenGeniText,
  phase: StartupPhaseItem["phase"],
  status: StartupPhaseItem["status"],
  outcome: StartupPhaseItem["outcome"],
): string {
  if (status === "complete" && phase === "sandbox" && outcome && outcome !== "skipped") {
    if (outcome === "created") return t("timeline.platformActivityPresentation.sandboxCreated");
    if (outcome === "restored") return t("timeline.platformActivityPresentation.sandboxRestored");
    return t("timeline.platformActivityPresentation.sandboxReattached");
  }
  if (status === "complete" && phase === "rig" && outcome === "skipped") {
    return t("timeline.platformActivityPresentation.sandboxEnvironmentAlreadyReady");
  }
  const statusIndex =
    status === "running" ? 0 : status === "failed" ? 1 : status === "cancelled" ? 2 : 3;
  return STARTUP_PHASE_TITLES(t)[phase][statusIndex];
}

export const STARTUP_WAIT_TITLES = (
  t: OpenGeniText,
): Record<NonNullable<StartupPhaseItem["blockedReason"]>, string> => ({
  capture_in_progress: t("timeline.platformActivityPresentation.waitingForSandboxCheckpoint"),
  rotation_in_progress: t("timeline.platformActivityPresentation.waitingForSandboxRotation"),
  provider_recovery_in_progress: t(
    "timeline.platformActivityPresentation.waitingForSandboxRecovery",
  ),
  compaction_required: t("timeline.platformActivityPresentation.compactingConversationFirst"),
});

const STARTUP_PHASE_TITLES = (
  t: OpenGeniText,
): Record<StartupPhaseItem["phase"], readonly [string, string, string, string]> => ({
  queue: [
    t("timeline.platformActivityPresentation.waitingForAWorker"),
    t("timeline.platformActivityPresentation.workerStartupFailed"),
    t("timeline.platformActivityPresentation.workerWaitInterrupted"),
    t("timeline.platformActivityPresentation.workerStarted"),
  ],
  sandbox: [
    t("timeline.platformActivityPresentation.startingSandbox"),
    t("timeline.platformActivityPresentation.sandboxDidnTStart"),
    t("timeline.platformActivityPresentation.sandboxStartupInterrupted"),
    t("timeline.platformActivityPresentation.sandboxReady"),
  ],
  rig: [
    t("timeline.platformActivityPresentation.settingUpSandboxEnvironment"),
    t("timeline.platformActivityPresentation.sandboxEnvironmentSetupFailed"),
    t("timeline.platformActivityPresentation.sandboxEnvironmentSetupInterrupted"),
    t("timeline.platformActivityPresentation.sandboxEnvironmentReady"),
  ],
  repository: [
    t("timeline.platformActivityPresentation.preparingRepository"),
    t("timeline.platformActivityPresentation.repositoryPreparationFailed"),
    t("timeline.platformActivityPresentation.repositoryPreparationInterrupted"),
    t("timeline.platformActivityPresentation.repositoryReady"),
  ],
  files: [
    t("timeline.platformActivityPresentation.preparingFiles"),
    t("timeline.platformActivityPresentation.filePreparationFailed"),
    t("timeline.platformActivityPresentation.filePreparationInterrupted"),
    t("timeline.platformActivityPresentation.filesReady"),
  ],
  tools: [
    t("timeline.platformActivityPresentation.connectingTools"),
    t("timeline.platformActivityPresentation.toolConnectionFailed"),
    t("timeline.platformActivityPresentation.toolConnectionInterrupted"),
    t("timeline.platformActivityPresentation.toolsReady"),
  ],
  history: [
    t("timeline.platformActivityPresentation.loadingConversationHistory"),
    t("timeline.platformActivityPresentation.conversationHistoryDidnTLoad"),
    t("timeline.platformActivityPresentation.conversationHistoryLoadingInterrupted"),
    t("timeline.platformActivityPresentation.conversationHistoryLoaded"),
  ],
  model_preparation: [
    t("timeline.platformActivityPresentation.preparingRuntimeAndModelRequest"),
    t("timeline.platformActivityPresentation.runtimeModelPreparationFailed"),
    t("timeline.platformActivityPresentation.runtimeModelPreparationInterrupted"),
    t("timeline.platformActivityPresentation.modelRequestDispatched"),
  ],
  provider_first_byte: [
    t("timeline.platformActivityPresentation.waitingForModel"),
    t("timeline.platformActivityPresentation.modelDidnTRespond"),
    t("timeline.platformActivityPresentation.modelWaitInterrupted"),
    t("timeline.platformActivityPresentation.modelStartedResponding"),
  ],
});

export function startupDuration(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * A title that names an agent: the words around the name stay quiet and the
 * name carries the emphasis. `name` is null when no title is known, and
 * `text` is then the generic fallback.
 */
export type AgentTitleParts = {
  before: string;
  name: string | null;
  after: string;
  text: string;
};

const AGENT_NAME_SLOT = "\u0000agent\u0000";

/**
 * `render` turns a name into the full title (a translated template with a `{name}` slot),
 * so each language orders the words around the name itself.
 */
export function namedAgentTitle(
  name: string | null | undefined,
  render: (name: string) => string,
  fallback: string,
): AgentTitleParts {
  const trimmed = name?.trim() ? name.trim() : null;
  if (!trimmed) return { before: "", name: null, after: "", text: fallback };
  const shape = render(AGENT_NAME_SLOT);
  const at = shape.indexOf(AGENT_NAME_SLOT);
  if (at < 0) return { before: "", name: null, after: "", text: render(trimmed) };
  const before = shape.slice(0, at);
  const after = shape.slice(at + AGENT_NAME_SLOT.length);
  return { before, name: trimmed, after, text: `${before}${trimmed}${after}` };
}

/** The worker step title for a spawn or message, by status, naming the agent when known. */
export function workerRowTitleParts(
  t: OpenGeniText,
  item: Pick<WorkerItem, "action" | "status">,
  name?: string | null,
): AgentTitleParts {
  const fallback = workerRowTitle(t, item);
  const spawn = item.action === "spawn";
  switch (item.status) {
    case "running":
      return namedAgentTitle(
        name,
        (agent) =>
          spawn
            ? t("timeline.platformActivityPresentation.spawningName", { name: agent })
            : t("timeline.platformActivityPresentation.messagingName", { name: agent }),
        fallback,
      );
    case "failed":
      return namedAgentTitle(
        name,
        (agent) =>
          spawn
            ? t("timeline.platformActivityPresentation.couldNotSpawnName", { name: agent })
            : t("timeline.platformActivityPresentation.couldNotMessageName", { name: agent }),
        fallback,
      );
    case "cancelled":
      return namedAgentTitle(
        name,
        (agent) =>
          spawn
            ? t("timeline.platformActivityPresentation.spawningName", { name: agent })
            : t("timeline.platformActivityPresentation.messagingName", { name: agent }),
        fallback,
      );
    default:
      return namedAgentTitle(
        name,
        (agent) =>
          spawn
            ? t("timeline.platformActivityPresentation.spawnedName", { name: agent })
            : t("timeline.platformActivityPresentation.messagedName", { name: agent }),
        fallback,
      );
  }
}

/** The generic worker step title for a spawn or message, by status. */
export function workerRowTitle(
  t: OpenGeniText,
  item: Pick<WorkerItem, "action" | "status">,
): string {
  const running = item.status === "running";
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  return item.action === "spawn"
    ? running
      ? t("timeline.platformActivityPresentation.spawningWorker")
      : failed
        ? t("timeline.platformActivityPresentation.workerSpawnFailed")
        : cancelled
          ? t("timeline.platformActivityPresentation.workerInterrupted")
          : t("timeline.platformActivityPresentation.workerSpawned")
    : running
      ? t("timeline.platformActivityPresentation.messagingWorker")
      : failed
        ? t("timeline.platformActivityPresentation.workerMessageFailed")
        : cancelled
          ? t("timeline.platformActivityPresentation.workerInterrupted")
          : t("timeline.platformActivityPresentation.workerMessaged");
}
