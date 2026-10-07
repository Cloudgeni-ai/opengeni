import type { EffectiveSessionControl, SessionEvent, SessionStatus } from "@opengeni/sdk";
import { projectSessionRealtimeLifecycle } from "@opengeni/sdk/realtime";
import { useEffect, useMemo, useState } from "react";

import {
  RealtimeVoiceControl,
  useSessionRealtime,
  type RealtimeModelOption,
} from "./realtime-control";

/**
 * The stock conversation's live voice button (lazy chunk). The conversation
 * mounts it only when the workspace catalog offers an available voice model;
 * this owns choosing among those models and the call itself.
 */
export default function EmbeddedRealtimeVoice(props: {
  /** The conversation's client, which serves the realtime routes (or a proxy of them). */
  client: unknown;
  workspaceId: string;
  /** Available voice models, already filtered by the conversation. */
  models: readonly RealtimeModelOption[];
  sessionId: string;
  sessionStatus: SessionStatus;
  effectiveControl: EffectiveSessionControl;
  events: SessionEvent[];
  eventsReady: boolean;
  onVoiceActiveChange?: ((active: boolean) => void) | undefined;
}) {
  const lifecycle = useMemo(() => projectSessionRealtimeLifecycle(props.events), [props.events]);
  // A call already running (this browser after reload, or another one) fixes the model.
  const activeModel =
    lifecycle?.state === "active" && !(Date.parse(lifecycle.leaseExpiresAt) <= Date.now())
      ? lifecycle.model
      : null;
  const [chosen, setChosen] = useState<string | null>(null);
  const fallback = props.models.find((model) => model.recommended) ?? props.models[0]!;
  const selected =
    props.models.find((model) => model.id === (activeModel ?? chosen)) ??
    (activeModel ? { ...fallback, id: activeModel } : fallback);
  const realtime = useSessionRealtime({
    client: props.client as Parameters<typeof useSessionRealtime>[0]["client"],
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    sessionStatus: props.sessionStatus,
    effectiveControl: props.effectiveControl,
    events: props.events,
    eventsReady: props.eventsReady,
    codexConnected: false,
    model: selected.id,
    modelAvailable: selected.available,
    modelUnavailableReason: selected.unavailableReason,
  });
  const voiceActive = realtime.snapshot.mode?.state === "active";
  const onVoiceActiveChange = props.onVoiceActiveChange;
  useEffect(() => {
    onVoiceActiveChange?.(voiceActive);
  }, [onVoiceActiveChange, voiceActive]);
  useEffect(() => () => onVoiceActiveChange?.(false), [onVoiceActiveChange]);

  return (
    <RealtimeVoiceControl
      snapshot={realtime.snapshot}
      canStart={realtime.canStart}
      admissionBlocker={realtime.admissionBlocker}
      modelAvailable={selected.available}
      menuSide="top"
      modelMenu="split"
      showDiagnostics={false}
      audioRef={realtime.audioRef}
      selectedModel={selected}
      models={props.models}
      onSelectModel={realtime.lifecycleActive ? undefined : setChosen}
      onStart={realtime.start}
      onStop={realtime.stop}
      onRetry={realtime.retry}
      onRetryAudibleOutput={realtime.retryAudibleOutput}
      onSetInputMuted={realtime.setInputMuted}
      onSetOutputMuted={realtime.setOutputMuted}
    />
  );
}
