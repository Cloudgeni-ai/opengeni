import type { ClientVoiceInputConfig, ReasoningEffort } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { cachedClientConfigRead } from "../lib/client-config-read";

/** The client-config fields the stock conversation and chat read. */
export type ClientConfigFlagsSource = {
  getClientConfig: () => Promise<{
    fileUploads?: { enabled?: boolean };
    modelSelection?: boolean | undefined;
    chatConnections?: boolean | undefined;
    sandboxFiles?: boolean | undefined;
    defaultReasoningEffort?: ReasoningEffort | undefined;
    artifacts?: unknown;
    sessionCreation?: boolean | undefined;
    archive?: boolean | undefined;
    voiceInput?: ClientVoiceInputConfig | undefined;
    realtimeVoice?: boolean | undefined;
    browserExtension?: { name: string; installUrl: string } | undefined;
  }>;
};

export type ClientConfigFlags = {
  /**
   * Whether the config has loaded. Capability flags stay `true` until it says
   * otherwise. Current session proxies report only `artifacts`, `fileUploads`
   * and `modelSelection`; the other `false` flags come from older proxies.
   */
  loaded: boolean;
  uploads: boolean;
  modelSelection: boolean;
  /**
   * Agent capability cards may be set up in the chat. `false` only when a
   * session proxy owns chat setup (`createSession`).
   */
  chatConnections: boolean;
  sandboxFiles: boolean;
  defaultReasoningEffort: ReasoningEffort | null;
  /**
   * Inline Site previews and the artifact viewer. `false` only when the config
   * says they are unavailable (a session proxy that cannot open the editor's
   * live socket); native deployments omit the flag.
   */
  artifacts: boolean;
  /** Browser chat creation. `false` only when an older session proxy reports it off. */
  sessionCreation: boolean;
  /** Chat archive/restore. `false` only when an older session proxy reports it off. */
  archive: boolean;
  /** Native voice input when the deployment can transcribe, else null. */
  voiceInput: ClientVoiceInputConfig | null;
  /**
   * Live voice. `false` until the config loads and when an older session proxy
   * turns it off; availability otherwise comes from the realtime model catalog.
   */
  realtimeVoice: boolean;
  /**
   * An older session proxy explicitly offers live voice (`realtimeVoice:
   * true`). Embedded conversations show the voice button only then or when
   * their `realtimeVoice` prop is `true`.
   */
  realtimeVoiceOffered: boolean;
  /**
   * The Chrome extension the deployment offers for people's own Chrome, or
   * null until the config loads or when the server doesn't say (Opengeni Browser).
   */
  browserExtension: { name: string; installUrl: string } | null;
};

const INITIAL_FLAGS: ClientConfigFlags = {
  loaded: false,
  uploads: false,
  modelSelection: false,
  chatConnections: false,
  sandboxFiles: false,
  defaultReasoningEffort: null,
  artifacts: true,
  sessionCreation: true,
  archive: true,
  voiceInput: null,
  realtimeVoice: false,
  realtimeVoiceOffered: false,
  browserExtension: null,
};

/** Deployment and session-proxy capabilities from the client config. */
export function useClientConfigFlags(
  client: Partial<ClientConfigFlagsSource> | ClientConfigFlagsSource,
): ClientConfigFlags {
  const [flags, setFlags] = useState<ClientConfigFlags>(INITIAL_FLAGS);
  useEffect(() => {
    // Custom clients without a config read keep the defaults.
    if (typeof client.getClientConfig !== "function") return;
    let live = true;
    // One read per client: the chat, its list, the new-chat composer and the
    // conversation all ask, and behind a session proxy each read is a round trip.
    cachedClientConfigRead(client as ClientConfigFlagsSource).then(
      (config) => {
        if (live) {
          setFlags({
            loaded: true,
            uploads: config.fileUploads?.enabled === true,
            // Only an explicit offer shows end users the picker.
            modelSelection: config.modelSelection === true,
            chatConnections: config.chatConnections !== false,
            sandboxFiles: config.sandboxFiles !== false,
            defaultReasoningEffort: config.defaultReasoningEffort ?? null,
            artifacts: config.artifacts !== false,
            sessionCreation: config.sessionCreation !== false,
            archive: config.archive !== false,
            voiceInput: config.voiceInput?.available === true ? config.voiceInput : null,
            realtimeVoice: config.realtimeVoice !== false,
            realtimeVoiceOffered: config.realtimeVoice === true,
            browserExtension: config.browserExtension ?? null,
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
