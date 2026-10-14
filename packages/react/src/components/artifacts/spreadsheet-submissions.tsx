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

const standaloneQueue = {
  getPending: () => 0,
  subscribe: (_listener: () => void) => () => {},
  run: <T,>(invoke: () => Promise<T>) => invoke(),
};
const SubmissionContext = createContext<ReturnType<typeof createSubmissionQueue> | null>(null);

export function SpreadsheetSubmissionProvider({ children }: { children: ReactNode }) {
  const [queue] = useState(createSubmissionQueue);
  return <SubmissionContext.Provider value={queue}>{children}</SubmissionContext.Provider>;
}

export function useSpreadsheetSubmissions() {
  return useContext(SubmissionContext) ?? standaloneQueue;
}
