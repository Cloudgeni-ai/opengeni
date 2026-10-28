import { useEffect, useRef, useState } from "react";

/**
 * While a chat is stopped or waiting on its Codex usage limit, picking
 * another model in the composer picker continues the chat with that model:
 * once the composer shows the pick (with its effort and speed), once.
 * Picking the chat's own model continues nothing.
 */
export function useCodexUsageModelSwitch(input: {
  sessionId: string;
  /** The chat's current (Codex) model. */
  sessionModel: string;
  /** The model the composer shows now. */
  composerModel: string;
  /** The chat is blocked on its Codex usage and the person may continue it. */
  enabled: boolean;
  closePicker: () => void;
  onContinue: (model: string) => void;
}) {
  const [picked, setPicked] = useState<{ sessionId: string; model: string } | null>(null);
  // The picker commits a model with its effort and speed in one update; the
  // chat continues once the composer shows that model.
  const switched =
    picked?.sessionId === input.sessionId && picked.model === input.composerModel
      ? picked.model
      : null;
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    if (!switched) return;
    setPicked(null);
    if (latest.current.enabled) latest.current.onContinue(switched);
  }, [switched]);
  return {
    modelPicked: (modelId: string) => {
      if (!input.enabled || modelId === input.sessionModel) return;
      setPicked({ sessionId: input.sessionId, model: modelId });
      input.closePicker();
    },
  };
}
