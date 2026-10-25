/**
 * The workspace's one meeting recorder, held above the routes so a recording
 * keeps going while the person moves around the app.
 *
 * The capture code (MediaRecorder, IndexedDB, the uploader) loads lazily: the
 * host mounts the first time someone opens Meetings, or at startup when this
 * browser still holds a recording that hasn't finished uploading. The live
 * snapshot changes several times a second while recording, so it lives in an
 * external store; only the components that read it re-render.
 */
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { UseRecorderResult } from "@opengeni/react/recordings";

export type MeetingRecorder = UseRecorderResult;

export type MeetingRecorderStore = {
  get: () => MeetingRecorder | null;
  subscribe: (listener: () => void) => () => void;
  set: (recorder: MeetingRecorder | null) => void;
  /** Recordings whose upload finished in this tab, newest last. */
  finished: () => readonly string[];
  markFinished: (recordingId: string) => void;
  /** Load the capture code. Idempotent. */
  activate: () => void;
};

export function createMeetingRecorderStore(
  onActivate: () => void = () => {},
): MeetingRecorderStore {
  let current: MeetingRecorder | null = null;
  let finished: string[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (recorder) => {
      current = recorder;
      notify();
    },
    finished: () => finished,
    markFinished: (recordingId) => {
      finished = [...finished.filter((id) => id !== recordingId), recordingId];
      notify();
    },
    activate: onActivate,
  };
}

const MeetingRecorderContext = createContext<MeetingRecorderStore | null>(null);

export const MeetingRecorderStoreProvider = MeetingRecorderContext.Provider;

const LazyRecorderHost = lazy(() => import("./recorder-host"));

const RECORDING_DATABASE = "opengeni-recordings";

/** True when this browser still holds recording chunks from an earlier visit. */
async function hasLocalRecordings(): Promise<boolean> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return false;
  try {
    const databases = await indexedDB.databases();
    return databases.some((database) => database.name === RECORDING_DATABASE);
  } catch {
    return false;
  }
}

export function MeetingRecorderProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const [active, setActive] = useState(false);
  const store = useMemo(() => createMeetingRecorderStore(() => setActive(true)), []);
  useEffect(() => {
    let cancelled = false;
    void hasLocalRecordings().then((found) => {
      if (found && !cancelled) setActive(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <MeetingRecorderContext.Provider value={store}>
      {children}
      {active ? (
        <Suspense fallback={null}>
          <LazyRecorderHost key={workspaceId} store={store} />
        </Suspense>
      ) : null}
    </MeetingRecorderContext.Provider>
  );
}

const NO_FINISHED: readonly string[] = [];

/** The live recorder, loading it on first use. Null until the capture code is ready. */
export function useMeetingRecorder(): {
  recorder: MeetingRecorder | null;
  finished: readonly string[];
} {
  const store = useContext(MeetingRecorderContext);
  useEffect(() => store?.activate(), [store]);
  const recorder = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.get ?? nullSnapshot,
    nullSnapshot,
  );
  const finished = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.finished ?? (() => NO_FINISHED),
    () => NO_FINISHED,
  );
  return { recorder, finished };
}

/** Only the recorder's state word, for the rail: re-renders on state changes, not on every tick. */
export function useMeetingRecorderState(): MeetingRecorder["state"] | null {
  const store = useContext(MeetingRecorderContext);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => store?.get()?.state ?? null,
    () => null,
  );
}

function noopSubscribe(): () => void {
  return () => {};
}

function nullSnapshot(): null {
  return null;
}
