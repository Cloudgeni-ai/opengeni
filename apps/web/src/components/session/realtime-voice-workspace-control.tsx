import {
  createBrowserRealtimeVoiceAdapter,
  RealtimeVoiceOrb,
  useComposer,
  useRealtimeVoice,
  useSession,
  useSessionEvents,
  type RealtimeVoiceFinalContext,
} from "@opengeni/react";
import { resolveWorkspaceMainSessionId } from "@opengeni/contracts";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { useAppContext } from "@/context";
import {
  resolveRealtimeVoiceTarget,
  sessionIdFromWorkspacePath,
  type RealtimeVoiceTargetMode,
} from "@/lib/realtime-voice";
import { cn } from "@/lib/utils";

export default function RealtimeVoiceWorkspaceControl({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const [mode, setMode] = useState<RealtimeVoiceTargetMode>("session");
  const selectedSessionId = useRouterState({
    select: (state): string | null => sessionIdFromWorkspacePath(state.location.pathname),
  });
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const mainSessionId = resolveWorkspaceMainSessionId(workspace?.settings);
  const targetSessionId = resolveRealtimeVoiceTarget(mode, selectedSessionId, mainSessionId);
  const missingDetail =
    mode === "session"
      ? "Open a session to use voice in This session mode."
      : "Choose a workspace main session in Workspace settings before using global voice.";

  return (
    <aside
      aria-label="Realtime voice"
      className="fixed right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-1.5 sm:right-4 sm:bottom-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div
        role="group"
        aria-label="Voice target"
        className="inline-flex rounded-og-lg border border-og-border bg-og-surface-1/95 p-0.5 shadow-og-sm backdrop-blur"
      >
        <TargetModeButton
          active={mode === "session"}
          label="This session"
          onClick={() => setMode("session")}
        />
        <TargetModeButton
          active={mode === "workspace-main"}
          label="Workspace main"
          onClick={() => setMode("workspace-main")}
        />
      </div>

      {targetSessionId ? (
        <RealtimeVoiceTargetControl
          key={`${mode}:${targetSessionId}`}
          workspaceId={workspaceId}
          sessionId={targetSessionId}
          mode={mode}
        />
      ) : (
        <RealtimeVoiceOrb
          status="unavailable"
          targetLabel={
            mode === "session" ? "This session — none selected" : "Workspace main — not set"
          }
          targetSessionId={null}
          unavailableDetail={missingDetail}
          onStart={() => undefined}
          onStop={() => undefined}
          onInterrupt={() => undefined}
          onTextFallback={() => undefined}
          textFallbackDisabled
          className="w-[min(25rem,calc(100vw-1.5rem))]"
        />
      )}
    </aside>
  );
}

function TargetModeButton(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        "rounded-og-md px-2.5 py-1 text-og-xs font-medium transition-colors pointer-coarse:min-h-11",
        props.active
          ? "bg-og-surface-3 text-og-fg shadow-og-xs"
          : "text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg",
      )}
    >
      {props.label}
    </button>
  );
}

function RealtimeVoiceTargetControl(props: {
  workspaceId: string;
  sessionId: string;
  mode: RealtimeVoiceTargetMode;
}) {
  const navigate = useNavigate();
  const sessionQuery = useSession(props.sessionId);
  const eventLog = useSessionEvents(props.sessionId);
  const composer = useComposer(props.sessionId, { draftPersistence: "disabled" });
  const focusTextComposer = useCallback(async () => {
    await navigate({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId: props.workspaceId, sessionId: props.sessionId },
    });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLTextAreaElement>("[data-session-text-composer] textarea")
          ?.focus();
      });
    });
  }, [navigate, props.sessionId, props.workspaceId]);
  const targetPrefix = props.mode === "session" ? "This session" : "Workspace main";
  const title = sessionQuery.session?.title?.trim() || props.sessionId;

  if (sessionQuery.loading && !sessionQuery.session) {
    return (
      <RealtimeVoiceOrb
        status="authorizing"
        targetLabel={`${targetPrefix} — loading`}
        targetSessionId={props.sessionId}
        onStart={() => undefined}
        onStop={() => undefined}
        onInterrupt={() => undefined}
        onTextFallback={() => void focusTextComposer()}
        className="w-[min(25rem,calc(100vw-1.5rem))]"
      />
    );
  }

  if (sessionQuery.error || !sessionQuery.session) {
    return (
      <RealtimeVoiceOrb
        status="unavailable"
        targetLabel={`${targetPrefix} — unavailable`}
        targetSessionId={props.sessionId}
        unavailableDetail="The configured session is missing or inaccessible. Select another exact target; voice will not fall back."
        onStart={() => undefined}
        onStop={() => undefined}
        onInterrupt={() => undefined}
        onTextFallback={() => void focusTextComposer()}
        className="w-[min(25rem,calc(100vw-1.5rem))]"
      />
    );
  }

  const sessionStatus = eventLog.sessionStatus ?? sessionQuery.session.status;
  if (sessionStatus === "cancelled") {
    return (
      <RealtimeVoiceOrb
        status="unavailable"
        targetLabel={`${targetPrefix} — ${title}`}
        targetSessionId={props.sessionId}
        unavailableDetail="This session is cancelled and cannot accept new voice input."
        onStart={() => undefined}
        onStop={() => undefined}
        onInterrupt={() => undefined}
        onTextFallback={() => void focusTextComposer()}
        className="w-[min(25rem,calc(100vw-1.5rem))]"
      />
    );
  }

  return (
    <ActiveRealtimeVoiceTarget
      workspaceId={props.workspaceId}
      sessionId={props.sessionId}
      targetLabel={`${targetPrefix} — ${title}`}
      sessionStatus={sessionStatus}
      timeline={eventLog.timeline}
      submitFinal={(text, context) => composer.send(text, context.clientEventId)}
      onTextFallback={focusTextComposer}
    />
  );
}

function ActiveRealtimeVoiceTarget(props: {
  workspaceId: string;
  sessionId: string;
  targetLabel: string;
  sessionStatus: Exclude<ReturnType<typeof useSessionEvents>["sessionStatus"], null>;
  timeline: ReturnType<typeof useSessionEvents>["timeline"];
  submitFinal: (text: string, context: RealtimeVoiceFinalContext) => Promise<boolean>;
  onTextFallback: () => Promise<void>;
}) {
  const context = useAppContext();
  const adapter = useMemo(() => createBrowserRealtimeVoiceAdapter(), []);
  const completedAssistantMessage = useMemo(() => {
    for (let index = props.timeline.length - 1; index >= 0; index -= 1) {
      const item = props.timeline[index];
      if (item?.kind === "agent-message" && !item.streaming && item.text.trim()) {
        return { id: item.id, text: item.text };
      }
    }
    return null;
  }, [props.timeline]);
  const voice = useRealtimeVoice({
    client: context.client,
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    adapter,
    sessionStatus: props.sessionStatus,
    onFinalTranscript: props.submitFinal,
    completedAssistantMessage,
  });

  return (
    <RealtimeVoiceOrb
      status={voice.status}
      targetLabel={props.targetLabel}
      targetSessionId={props.sessionId}
      partial={voice.partial}
      unavailableReason={voice.capability?.reason}
      errorCode={voice.errorCode}
      onStart={() => void voice.start()}
      onStop={() => void voice.stop()}
      onInterrupt={() => void voice.interrupt()}
      onTextFallback={() => void props.onTextFallback()}
      className="w-[min(25rem,calc(100vw-1.5rem))]"
    />
  );
}
