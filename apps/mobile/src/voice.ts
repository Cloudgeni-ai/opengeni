import { useNativeVoiceInput, type NativeVoiceInput } from "@opengeni/react-native";
import { transcribeExpoRecording, useExpoVoiceRecorder } from "@opengeni/react-native/expo";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "@/account";

type VoiceCapability = {
  workspaceId: string;
  available: boolean;
  maxDurationSeconds: number | null;
};

/**
 * Composer dictation for the signed-in account: offered when this workspace's
 * deployment can transcribe (the same per-workspace check the web composer uses).
 */
export function useComposerVoice(input: {
  workspaceId: string | null;
  value: string;
  setValue: (value: string) => void;
  /** Changing this (another session or workspace) cancels a running capture. */
  scope: string;
}): NativeVoiceInput {
  const { client } = useAccount();
  const recorder = useExpoVoiceRecorder();
  const [capability, setCapability] = useState<VoiceCapability | null>(null);
  const value = useRef(input.value);
  value.current = input.value;
  const workspaceId = input.workspaceId;

  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    client
      .getClientConfig({ workspaceId })
      .then((config) => {
        if (!current) return;
        setCapability({
          workspaceId,
          available: config.voiceInput?.available === true,
          maxDurationSeconds: config.voiceInput?.maxDurationSeconds ?? null,
        });
      })
      .catch(() => {
        if (current) setCapability({ workspaceId, available: false, maxDurationSeconds: null });
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId]);

  const ready = capability !== null && capability.workspaceId === workspaceId;
  return useNativeVoiceInput({
    recorder,
    available: Boolean(workspaceId) && ready && capability.available,
    maxDurationSeconds: ready ? capability.maxDurationSeconds : null,
    transcribe: (recording) =>
      transcribeExpoRecording({ client, workspaceId: workspaceId ?? "", recording }),
    getValue: () => value.current,
    setValue: input.setValue,
    scope: `${input.scope}:${workspaceId ?? ""}`,
    onFeedback: (event) =>
      void (event === "start"
        ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
        : Haptics.selectionAsync()),
  });
}
