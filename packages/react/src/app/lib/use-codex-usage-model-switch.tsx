import { useEffect, useRef, useState } from "react";

/**
 * "Switch model" on a chat out of Codex usage: open the composer's model
 * picker, and once the person picks another model and the composer shows it,
 * continue the chat with that model, once. Closing the picker without a pick,
 * or picking the chat's own model, continues nothing.
 */
export function useCodexUsageModelSwitch(input: {
  sessionId: string;
  /** The chat's current (Codex) model. */
  sessionModel: string;
  /** The model the composer shows now. */
  composerModel: string;
  /** The chat is still blocked on its Codex usage and the person may continue it. */
  enabled: boolean;
  openPicker: () => void;
  closePicker: () => void;
  onContinue: (model: string) => void;
}) {
  const [armed, setArmed] = useState<{ sessionId: string; model: string | null } | null>(null);
  const current = armed?.sessionId === input.sessionId ? armed : null;
  // The picker commits a model with its effort and speed in one update; the
  // chat continues once the composer shows that model.
  const switched =
    current?.model !== null && current?.model === input.composerModel ? current.model : null;
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    if (!switched) return;
    setArmed(null);
    if (latest.current.enabled) latest.current.onContinue(switched);
  }, [switched]);
  return {
    start: () => {
      setArmed({ sessionId: input.sessionId, model: null });
      input.openPicker();
    },
    modelPicked: (modelId: string) => {
      if (!current || modelId === input.sessionModel) return;
      setArmed({ sessionId: input.sessionId, model: modelId });
      input.closePicker();
    },
    pickerClosed: () => setArmed((pending) => (pending?.model === null ? null : pending)),
  };
}
