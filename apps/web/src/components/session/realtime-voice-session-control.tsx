import { createBrowserRealtimeVoiceAdapter, RealtimeVoiceOrb } from "@opengeni/react";
import { useRealtimeVoice, type TimelineItem } from "@opengeni/react/session";
import type { OpenGeniClient, SessionStatus } from "@opengeni/sdk";
import { useCallback, useMemo } from "react";

export type RealtimeVoiceSessionControlProps = {
  client: OpenGeniClient;
  workspaceId: string;
  sessionId: string;
  sessionStatus: SessionStatus;
  sessionTitle?: string | null;
  timeline: readonly TimelineItem[];
  onFinalTranscript: (text?: string) => Promise<boolean>;
};

export default function RealtimeVoiceSessionControl(props: RealtimeVoiceSessionControlProps) {
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
  const focusTextComposer = useCallback(() => {
    document.querySelector<HTMLTextAreaElement>("[data-session-text-composer] textarea")?.focus();
  }, []);
  const voice = useRealtimeVoice({
    client: props.client,
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    adapter,
    sessionStatus: props.sessionStatus,
    // Accepted utterances are ordinary Send operations. Voice never silently
    // Steers, creates another thread, or bypasses the durable prompt queue.
    onFinalTranscript: props.onFinalTranscript,
    completedAssistantMessage,
  });

  return (
    <RealtimeVoiceOrb
      status={voice.status}
      targetLabel={`This session — ${props.sessionTitle ?? props.sessionId}`}
      targetSessionId={props.sessionId}
      partial={voice.partial}
      unavailableReason={voice.capability?.reason}
      errorCode={voice.errorCode}
      onStart={() => void voice.start()}
      onStop={() => void voice.stop()}
      onInterrupt={() => void voice.interrupt()}
      onTextFallback={focusTextComposer}
    />
  );
}
