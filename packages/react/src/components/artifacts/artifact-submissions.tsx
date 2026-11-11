import type { EditableArtifactSession } from "@opengeni/sdk/editable-artifacts";
import { createContext, useContext, useState, type ReactNode } from "react";

function createSubmissionQueue() {
  let pending = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    getPending: () => pending,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async run<T>(invoke: () => Promise<T>): Promise<T> {
      // The SDK's causal queue and Worker authoring precede pendingTransactions.
      // Latch synchronously so a same-event blur/click cannot export an older head.
      pending++;
      emit();
      try {
        return await invoke();
      } finally {
        pending--;
        emit();
      }
    },
  };
}

export type ArtifactSubmissions = Readonly<{
  getPending: () => number;
  subscribe: (listener: () => void) => () => void;
  run: <T>(invoke: () => Promise<T>) => Promise<T>;
}>;

const standaloneQueue: ArtifactSubmissions = {
  getPending: () => 0,
  subscribe: (_listener: () => void) => () => {},
  run: <T,>(invoke: () => Promise<T>) => invoke(),
};
const SubmissionContext = createContext<ArtifactSubmissions | null>(null);

export function ArtifactSubmissionProvider({ children }: { children: ReactNode }) {
  const [queue] = useState(createSubmissionQueue);
  return <SubmissionContext.Provider value={queue}>{children}</SubmissionContext.Provider>;
}

/** UI authoring submissions not yet visible as SDK pending transactions. */
export function useArtifactSubmissions(): ArtifactSubmissions {
  return useContext(SubmissionContext) ?? standaloneQueue;
}

const SESSION_KEYS = new WeakMap<EditableArtifactSession, number>();
let nextSessionKey = 0;

/** Stable per-session React key so a replaced session never inherits queued state. */
export function artifactSubmissionSessionKey(session: EditableArtifactSession): number {
  let key = SESSION_KEYS.get(session);
  if (key === undefined) {
    key = ++nextSessionKey;
    SESSION_KEYS.set(session, key);
  }
  return key;
}
