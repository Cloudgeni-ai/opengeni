import { readClientConfig } from "@opengeni/react/session";
import { useNativeVoiceInput, type NativeVoiceInput } from "@opengeni/react-native";
import { transcribeExpoRecording, useExpoVoiceRecorder } from "@opengeni/react-native/expo";
import { useNativeDictation, useNativeRecorderPlatform } from "@opengeni/react-native/recordings";
import type { ClientVoiceInputConfig } from "@opengeni/sdk";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "@/account";

type VoiceCapability = {
  workspaceId: string;
  config: ClientVoiceInputConfig | null;
};

/**
 * Composer dictation for the signed-in account: offered when this workspace's
 * deployment can transcribe (the same per-workspace check the web composer uses).
 * Where the deployment keeps dictations, each one is a recording on the
 * phone and the server until its text is in the draft.
 */
export function useComposerVoice(input: {
  workspaceId: string | null;
  value: string;
  setValue: (value: string) => void;
  /** Changing this (another session or workspace) cancels a running capture. */
  scope: string;
}): NativeVoiceInput {
  const { account, client } = useAccount();
  const recorder = useExpoVoiceRecorder();
  const platform = useNativeRecorderPlatform(account ? { storeScope: account.id } : {});
  const [capability, setCapability] = useState<VoiceCapability | null>(null);
  const value = useRef(input.value);
  value.current = input.value;
  const workspaceId = input.workspaceId;

  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    // Joins the conversation's own read of this workspace's config.
    readClientConfig(client, workspaceId)
      .then((config) => {
        if (!current) return;
        setCapability({ workspaceId, config: config.voiceInput ?? null });
      })
      .catch(() => {
        if (current) setCapability({ workspaceId, config: null });
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId]);

  const ready = capability !== null && capability.workspaceId === workspaceId;
  const config = ready ? capability.config : null;
  const available = Boolean(workspaceId) && config?.available === true;
  const durable = available && Boolean(config?.resumable) && platform.supported;
  const onFeedback = (event: "start" | "stop" | "cancel") =>
    void (event === "start"
      ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      : Haptics.selectionAsync());
  const scope = `${input.scope}:${workspaceId ?? ""}`;
  const dictation = useNativeDictation({
    client,
    workspaceId: workspaceId ?? "",
    capability: durable ? config : null,
    platform,
    value: input.value,
    setValue: input.setValue,
    scope,
    onFeedback,
  });
  // A deployment that can't keep dictations transcribes each one in one request.
  const oneShot = useNativeVoiceInput({
    recorder: durable ? null : recorder,
    available: available && !durable,
    maxDurationSeconds: config?.maxDurationSeconds ?? null,
    transcribe: (recording) =>
      transcribeExpoRecording({ client, workspaceId: workspaceId ?? "", recording }),
    getValue: () => value.current,
    setValue: input.setValue,
    scope,
    onFeedback,
  });
  return durable ? dictation : oneShot;
}
