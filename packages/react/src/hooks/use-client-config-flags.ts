import type { ClientVoiceInputConfig, ReasoningEffort } from "@opengeni/sdk";
import { useEffect, useState } from "react";

/** The client-config fields the stock conversation and chat read. */
export type ClientConfigFlagsSource = {
  getClientConfig: () => Promise<{
    fileUploads?: { enabled?: boolean };
    modelSelection?: boolean | undefined;
    sandboxFiles?: boolean | undefined;
    defaultReasoningEffort?: ReasoningEffort | undefined;
    artifacts?: unknown;
    sessionCreation?: boolean | undefined;
    archive?: boolean | undefined;
    voiceInput?: ClientVoiceInputConfig | undefined;
  }>;
};

export type ClientConfigFlags = {
  /** Whether the config has loaded. Proxy capability flags stay `true` until it says otherwise. */
  loaded: boolean;
  uploads: boolean;
  modelSelection: boolean;
  sandboxFiles: boolean;
  defaultReasoningEffort: ReasoningEffort | null;
  /**
   * Inline Site previews and the artifact viewer. `false` only when a session
   * proxy says it does not serve them; native deployments omit the flag.
   */
  artifacts: boolean;
  /** Browser chat creation. `false` only when a session proxy has no `createSession` hook. */
  sessionCreation: boolean;
  /** Chat archive/restore. `false` only when a session proxy disables it. */
  archive: boolean;
  /** Native voice input when the deployment can transcribe, else null. */
  voiceInput: ClientVoiceInputConfig | null;
};

const INITIAL_FLAGS: ClientConfigFlags = {
  loaded: false,
  uploads: false,
  modelSelection: false,
  sandboxFiles: false,
  defaultReasoningEffort: null,
  artifacts: true,
  sessionCreation: true,
  archive: true,
  voiceInput: null,
};

type ClientConfigFlagsInput = Awaited<ReturnType<ClientConfigFlagsSource["getClientConfig"]>>;

// One read per client: the chat, its list, the new-chat composer and the
// conversation all ask, and behind a session proxy each read is a round trip.
const configReads = new WeakMap<object, Promise<ClientConfigFlagsInput>>();

function readClientConfig(client: ClientConfigFlagsSource): Promise<ClientConfigFlagsInput> {
  let read = configReads.get(client);
  if (!read) {
    read = client.getClientConfig();
    configReads.set(client, read);
    // A failed read is retried by the next mount rather than cached.
    read.catch(() => {
      if (configReads.get(client) === read) configReads.delete(client);
    });
  }
  return read;
}

/** Deployment and session-proxy capabilities from the client config. */
export function useClientConfigFlags(
  client: Partial<ClientConfigFlagsSource> | ClientConfigFlagsSource,
): ClientConfigFlags {
  const [flags, setFlags] = useState<ClientConfigFlags>(INITIAL_FLAGS);
  useEffect(() => {
    // Custom clients without a config read keep the defaults.
    if (typeof client.getClientConfig !== "function") return;
    let live = true;
    readClientConfig(client as ClientConfigFlagsSource).then(
      (config) => {
        if (live) {
          setFlags({
            loaded: true,
            uploads: config.fileUploads?.enabled === true,
            // Only an explicit offer shows end users the picker.
            modelSelection: config.modelSelection === true,
            sandboxFiles: config.sandboxFiles !== false,
            defaultReasoningEffort: config.defaultReasoningEffort ?? null,
            artifacts: config.artifacts !== false,
            sessionCreation: config.sessionCreation !== false,
            archive: config.archive !== false,
            voiceInput: config.voiceInput?.available === true ? config.voiceInput : null,
          });
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);
  return flags;
}
