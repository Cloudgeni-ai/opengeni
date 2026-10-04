import type { ClientConfig } from "@opengeni/sdk";

/** Retire old workspace reads before they can update the shared composer. */
export function startWorkspaceVoiceCapabilityRefresh(input: {
  read(signal: AbortSignal): Promise<ClientConfig>;
  ownsWorkspace(): boolean;
  apply(voiceInput: ClientConfig["voiceInput"]): void;
  subscribeFocus(refresh: () => void): () => void;
}): () => void {
  let request: AbortController | null = null;
  let disposed = false;
  const refresh = () => {
    if (disposed || !input.ownsWorkspace()) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    void input
      .read(controller.signal)
      .then((config) => {
        if (!controller.signal.aborted && input.ownsWorkspace()) input.apply(config.voiceInput);
      })
      .catch(() => {
        // Keep unavailable state after a transition; focus retries transient reads.
      });
  };
  refresh();
  const unsubscribe = input.subscribeFocus(refresh);
  return () => {
    disposed = true;
    request?.abort();
    unsubscribe();
  };
}
