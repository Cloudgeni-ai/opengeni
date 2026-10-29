/**
 * The app's one meeting recorder, held above the screens so a recording keeps
 * going while the person moves around the app (and, with the native module,
 * while the phone is locked or another app is in front).
 *
 * Audio is written to the phone's storage as it is captured and uploaded in the
 * background. Unsent audio is kept per `storeScope` (the signed-in account) and
 * only ever uploaded with that account's client; recordings the app could not
 * finish (killed, offline) finish the next time that account is active.
 *
 * The recorder runs in a host beside the screens, not around them: a new
 * `storeScope` or workspace starts a fresh recorder without remounting the
 * screens below, and the live snapshot, which changes several times a second
 * while recording, re-renders only the components that read it.
 *
 * A recording belongs to the workspace it started in: switching workspace
 * while one is being captured leaves it recording there, and the recorder
 * moves to the new workspace once it stops. A new account still ends it.
 */
import { useRecorder, type UseRecorderResult } from "@opengeni/react/recordings";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNativeRecorderPlatform, type NativeRecorderPlatformOptions } from "../recordings";

export type MeetingRecorder = UseRecorderResult & {
  /** Recordings whose upload finished while the app was open, newest last. */
  finished: readonly string[];
};

type RecorderStore = {
  get: () => MeetingRecorder | null;
  subscribe: (listener: () => void) => () => void;
  set: (recorder: UseRecorderResult) => void;
  /** Stop showing this recorder, unless another has replaced it already. */
  release: (recorder: UseRecorderResult) => void;
  markFinished: (recordingId: string) => void;
};

function createRecorderStore(): RecorderStore {
  let recorder: UseRecorderResult | null = null;
  let finished: readonly string[] = [];
  let snapshot: MeetingRecorder | null = null;
  const listeners = new Set<() => void>();
  const publish = () => {
    snapshot = recorder ? { ...recorder, finished } : null;
    for (const listener of listeners) listener();
  };
  return {
    get: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      if (next === recorder) return;
      recorder = next;
      publish();
    },
    release: (previous) => {
      if (previous !== recorder) return;
      recorder = null;
      publish();
    },
    markFinished: (recordingId) => {
      finished = [...finished.filter((id) => id !== recordingId), recordingId];
      publish();
    },
  };
}

const MeetingRecorderContext = createContext<RecorderStore | null>(null);

export type MeetingRecorderProviderProps = NativeRecorderPlatformOptions & {
  /** The SDK client recordings upload with. The provider's client otherwise. */
  client?: object;
  /**
   * The workspace recordings are made in. The provider's workspace when
   * omitted; null while the host is still finding it (no recorder until then).
   */
  workspaceId?: string | null;
  children: ReactNode;
};

/**
 * Hold one recorder for everything below. When the account changes, pass its
 * client and a new `storeScope`: the recorder for the old account stops
 * capturing and finishes its uploads, and a fresh one starts for the new one.
 */
export function MeetingRecorderProvider({
  client,
  workspaceId,
  children,
  ...platformOptions
}: MeetingRecorderProviderProps) {
  const store = useMemo(createRecorderStore, []);
  const scope = platformOptions.storeScope ?? "";
  const busy = useSyncExternalStore(
    store.subscribe,
    () => isCapturing(store.get()),
    () => false,
  );
  // The host stays in the workspace a capture started in until it stops; a
  // new account replaces it at once.
  const [pinned, setPinned] = useState({ scope, workspaceId });
  if (pinned.scope !== scope || (!busy && pinned.workspaceId !== workspaceId)) {
    setPinned({ scope, workspaceId });
  }
  const hostWorkspaceId = pinned.scope === scope ? pinned.workspaceId : workspaceId;
  return (
    <MeetingRecorderContext.Provider value={store}>
      {children}
      {hostWorkspaceId === null ? null : (
        <RecorderHost
          key={`${scope}\n${hostWorkspaceId ?? ""}`}
          store={store}
          {...(client ? { client } : {})}
          {...(hostWorkspaceId ? { workspaceId: hostWorkspaceId } : {})}
          {...platformOptions}
        />
      )}
    </MeetingRecorderContext.Provider>
  );
}

/** Runs the recorder and publishes it to the provider's store; renders nothing. */
function RecorderHost({
  store,
  client,
  workspaceId,
  ...platformOptions
}: NativeRecorderPlatformOptions & {
  store: RecorderStore;
  client?: object;
  workspaceId?: string;
}) {
  const platform = useNativeRecorderPlatform(platformOptions);
  const recorder = useRecorder({
    ...(client ? { client } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    platform,
    onFinished: (recordingId) => store.markFinished(recordingId),
  });
  const published = useRef(recorder);
  useLayoutEffect(() => {
    published.current = recorder;
    store.set(recorder);
  });
  // A host for another account may already have published its own recorder.
  useEffect(() => () => store.release(published.current), [store]);
  return null;
}

/** The live recorder, or null outside a {@link MeetingRecorderProvider} or before it is ready. */
export function useMeetingRecorder(): MeetingRecorder | null {
  const store = useContext(MeetingRecorderContext);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.get ?? nullSnapshot,
    nullSnapshot,
  );
}

/** True while capture holds the microphone. */
export function isCapturing(recorder: MeetingRecorder | null): boolean {
  const state = recorder?.state;
  return (
    state === "starting" || state === "recording" || state === "paused" || state === "stopping"
  );
}

function noopSubscribe(): () => void {
  return () => {};
}

function nullSnapshot(): null {
  return null;
}
