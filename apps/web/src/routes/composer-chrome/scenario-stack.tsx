// Production SessionChrome + ChatComposer stack for the DEV harness.
import {
  ChatComposer,
  SessionChrome,
  type ComposerState,
  type UseGoalResult,
  type UseTurnQueueResult,
} from "@opengeni/react";
import type {
  ClientVoiceInputConfig,
  SessionGoal,
  SessionPendingInputPreview,
  SessionTurn,
} from "@opengeni/sdk";
import { useMemo, useState } from "react";

import { ComposerMobilePlus } from "@/components/composer-mobile-plus";
import { ModelPicker, SessionToolPicker } from "@/components/pickers";
import { SubagentTree } from "@/components/session/subagents";
import {
  emptyAttachments,
  galleryFirstPartyTools,
  galleryModelRows,
  galleryToolSelection,
  galleryToolServers,
  GALLERY_WORKSPACE_ID,
  type ChromeScenario,
} from "@/dev/composer-chrome-fixtures";
import type { IntelligenceEffort } from "@/lib/session-tools";

const VOICE_CAPABILITY: ClientVoiceInputConfig = {
  available: true,
  maxDurationSeconds: 60,
  maxSizeBytes: 25 * 1024 * 1024,
  acceptedMimeTypes: ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"],
};

const fixtureClient = {
  async transcribeAudio(): Promise<{ text: string; languages: string[] }> {
    return { text: "", languages: [] };
  },
};

/** Local mutable queue/inbox so harness hover actions visibly update. */
function useHarnessLiveQueue(seed: UseTurnQueueResult): {
  queue: UseTurnQueueResult;
  dismissIncoming: (inputId: string) => void;
} {
  const [turns, setTurns] = useState<SessionTurn[]>(seed.queue);
  const [inputs, setInputs] = useState<SessionPendingInputPreview[]>(seed.pendingInputs);

  const queue = useMemo<UseTurnQueueResult>(
    () => ({
      ...seed,
      queue: turns,
      pendingInputs: inputs,
      moveTurn: async (turnId, beforeTurnId) => {
        setTurns((prev) => {
          const from = prev.findIndex((turn) => turn.id === turnId);
          if (from < 0) return prev;
          const next = [...prev];
          const [moved] = next.splice(from, 1);
          if (!moved) return prev;
          if (beforeTurnId === null) {
            next.push(moved);
          } else {
            const to = next.findIndex((turn) => turn.id === beforeTurnId);
            if (to < 0) next.push(moved);
            else next.splice(to, 0, moved);
          }
          return next;
        });
        return true;
      },
      editTurn: async (turnId) => {
        setTurns((prev) => prev.filter((turn) => turn.id !== turnId));
        return null;
      },
      steerTurn: async (turnId) => {
        setTurns((prev) => {
          const from = prev.findIndex((turn) => turn.id === turnId);
          if (from <= 0) return prev;
          const next = [...prev];
          const [moved] = next.splice(from, 1);
          if (!moved) return prev;
          next.unshift(moved);
          return next;
        });
        return true;
      },
      removeTurn: async (turnId) => {
        setTurns((prev) => prev.filter((turn) => turn.id !== turnId));
        return true;
      },
    }),
    [inputs, seed, turns],
  );

  return {
    queue,
    dismissIncoming: (inputId) => {
      setInputs((prev) => prev.filter((input) => input.id !== inputId));
    },
  };
}

function useHarnessLiveGoal(seed: UseGoalResult): UseGoalResult {
  const [goal, setGoal] = useState<SessionGoal | null>(seed.goal);
  return useMemo(
    () => ({
      ...seed,
      goal,
      isActive: goal?.status === "active",
      isPaused: goal?.status === "paused",
      isCompleted: goal?.status === "completed",
      pause: async () => {
        if (!goal || goal.status !== "active") return goal;
        const next: SessionGoal = {
          ...goal,
          status: "paused",
          pausedReason: "Paused from the gallery",
          continuation: {
            state: "inactive",
            reason: "goal_inactive",
            wakeRevision: goal.continuation?.wakeRevision ?? 0,
            observedRevision: goal.continuation?.observedRevision ?? 0,
            nextAttemptAt: null,
            lastError: null,
          },
        };
        setGoal(next);
        return next;
      },
      resume: async () => {
        if (!goal || goal.status !== "paused") return goal;
        const next: SessionGoal = {
          ...goal,
          status: "active",
          pausedReason: null,
          continuation: {
            state: "scheduled",
            reason: "wake_pending",
            wakeRevision: (goal.continuation?.wakeRevision ?? 0) + 1,
            observedRevision: goal.continuation?.observedRevision ?? 0,
            nextAttemptAt: new Date().toISOString(),
            lastError: null,
          },
        };
        setGoal(next);
        return next;
      },
      clearGoal: async () => {
        setGoal(null);
      },
      deleteGoal: async () => {
        setGoal(null);
      },
    }),
    [goal, seed],
  );
}

export function ScenarioStack({
  scenario,
  composer,
  /** Phone stage uses tighter padding to match the session dock. */
  variant = "gallery",
}: {
  scenario: ChromeScenario;
  composer: ComposerState;
  variant?: "gallery" | "phone";
}) {
  const [model, setModel] = useState("gpt-5.6-sol");
  const [effort, setEffort] = useState<IntelligenceEffort>("medium");
  const [toolSelection, setToolSelection] = useState(galleryToolSelection);
  const attachments = useMemo(() => emptyAttachments(), []);
  const { queue, dismissIncoming } = useHarnessLiveQueue(scenario.queue);
  const goal = useHarnessLiveGoal(scenario.goal);
  const agents = scenario.agentNodes;

  const runningAgents = agents.filter(
    (node) => node.session.status === "running" && node.session.effectiveControl.state === "active",
  ).length;
  const pausedAgents = agents.filter(
    (node) => node.session.effectiveControl.state === "paused",
  ).length;

  const chrome = (
    <SessionChrome
      key={`${scenario.id}-${scenario.defaultActive ?? "none"}`}
      queue={queue}
      composer={composer}
      goal={goal}
      onDismissIncoming={dismissIncoming}
      defaultActive={scenario.defaultActive}
      agentsSignal={
        agents.length > 0
          ? {
              count: agents.length,
              detail:
                runningAgents > 0
                  ? `${runningAgents} running`
                  : pausedAgents > 0
                    ? `${pausedAgents} paused`
                    : "Idle",
              tone: runningAgents > 0 ? "running" : pausedAgents > 0 ? "waiting" : "neutral",
            }
          : undefined
      }
      agentsPanel={
        agents.length > 0 ? (
          <SubagentTree workspaceId={GALLERY_WORKSPACE_ID} nodes={agents} />
        ) : null
      }
    />
  );

  const composerBlock = (
    <ChatComposer
      composer={composer}
      effectiveControl={scenario.session.effectiveControl}
      queuedAheadCount={queue.queue.length}
      placeholder="Send a follow-up…"
      attachments={attachments}
      attachButtonClassName="max-sm:hidden"
      transcription={{
        client: fixtureClient as never,
        workspaceId: GALLERY_WORKSPACE_ID,
        capability: VOICE_CAPABILITY,
        workspaceEnabled: true,
      }}
      controlsLeading={
        <ComposerMobilePlus
          fileUploadsEnabled
          servers={galleryToolServers}
          firstPartyTools={galleryFirstPartyTools}
          selection={toolSelection}
          onToolSelectionChange={setToolSelection}
        />
      }
      controlsStart={
        <div className="flex min-w-0 items-center gap-1.5 max-sm:min-w-0 max-sm:flex-nowrap">
          <ModelPicker
            rows={galleryModelRows}
            model={model}
            effort={effort}
            latencyMode="standard"
            menuSide="top"
            onModelChange={setModel}
            onEffortChange={setEffort}
            onLatencyModeChange={() => {}}
          />
          <SessionToolPicker
            servers={galleryToolServers}
            firstPartyTools={galleryFirstPartyTools}
            selection={toolSelection}
            menuSide="top"
            triggerClassName="max-sm:hidden"
            onChange={setToolSelection}
          />
        </div>
      }
    />
  );

  if (variant === "phone") {
    return (
      <div className="shrink-0 border-t border-border/80 bg-bg" data-scenario={scenario.id}>
        <div className="px-3 pt-2">{chrome}</div>
        <div className="px-3 pb-2 pt-1">{composerBlock}</div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col justify-end rounded-xl border border-border bg-bg/40 pt-8"
      data-scenario={scenario.id}
      data-session-chrome-stack=""
    >
      <div className="mx-auto mb-2 w-full max-w-3xl shrink-0 px-4 sm:px-6">{chrome}</div>
      <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">{composerBlock}</div>
      </div>
    </div>
  );
}
