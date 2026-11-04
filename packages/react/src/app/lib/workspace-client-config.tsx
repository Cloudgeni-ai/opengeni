import type { ClientConfig } from "@opengeni/sdk";

/**
 * The client config fields the server answers for one workspace: voice input
 * readiness and what EU-only inference switched off there. Boot reads the
 * config without a workspace, so these come from a read for the open one.
 */
export type WorkspaceClientConfig = Pick<
  ClientConfig,
  "voiceInput" | "inferenceFeatures" | "agentConfig" | "codeSearch"
>;

export function workspaceClientConfig(config: ClientConfig): WorkspaceClientConfig {
  return {
    voiceInput: config.voiceInput,
    inferenceFeatures: config.inferenceFeatures,
    agentConfig: config.agentConfig,
    codeSearch: config.codeSearch,
  };
}

/**
 * The boot config with the open workspace's fields. Until that workspace has
 * answered, voice input stays off and nothing else changes.
 */
export function withWorkspaceClientConfig(
  config: ClientConfig,
  workspace: WorkspaceClientConfig | undefined,
): ClientConfig {
  if (workspace) return { ...config, ...workspace };
  return {
    ...config,
    voiceInput: config.voiceInput
      ? { ...config.voiceInput, available: false, providers: [] }
      : undefined,
  };
}

/**
 * Reads the open workspace's config now, on focus and on `refresh()`; retires
 * old workspace reads before they can update the shared app state.
 */
export function startWorkspaceClientConfigRefresh(input: {
  read(signal: AbortSignal): Promise<ClientConfig>;
  ownsWorkspace(): boolean;
  apply(config: WorkspaceClientConfig): void;
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
        if (!controller.signal.aborted && input.ownsWorkspace()) {
          input.apply(workspaceClientConfig(config));
        }
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
