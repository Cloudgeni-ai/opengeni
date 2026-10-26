/**
 * The workspace's one meeting recorder, held above the routes so a recording
 * keeps going while the person moves around the app.
 *
 * The capture code (MediaRecorder, IndexedDB, the uploader) loads lazily: the
 * host mounts the first time someone opens Meetings, or at startup when this
 * browser still holds a recording that hasn't finished uploading. The live
 * snapshot changes several times a second while recording, so it lives in an
 * external store; only the components that read it re-render.
 *
 * In the desktop app, the provider also carries out the call notifications'
 * choices; the host says where Meetings and a meeting are with
 * `onOpenMeetings` and `onOpenMeeting`.
 *
 * A recording belongs to the workspace it started in and keeps going when the
 * person moves to another workspace: the recorder follows the host's current
 * workspace only while nothing is being captured. It belongs to the person
 * too: a host that signs people in passes them as `scope`, and a recording
 * ends at once when they sign out or someone else signs in.
 */
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getDesktopBridge, hasDesktopCapability } from "@opengeni/sdk/desktop-bridge";
import type { UseRecorderResult } from "../recordings";

export type MeetingRecorder = UseRecorderResult;

/** A recording someone asked for outside the recorder, such as from a desktop call notification. */
export type MeetingStartRequest = { title: string };

export type MeetingRecorderStore = {
  get: () => MeetingRecorder | null;
  subscribe: (listener: () => void) => () => void;
  /** Publish the recorder, and the workspace its recordings go to. */
  set: (recorder: MeetingRecorder | null, workspaceId?: string | null) => void;
  /** Recordings whose upload finished in this tab, newest last. */
  finished: () => readonly string[];
  markFinished: (recordingId: string) => void;
  /** A start the recorder panel should make as soon as it can, or null. */
  pendingStart: () => MeetingStartRequest | null;
  requestStart: (request: MeetingStartRequest) => void;
  /** Take the pending start, so it happens once. */
  takeStart: () => MeetingStartRequest | null;
  /** Load the capture code. Idempotent. */
  activate: () => void;
  /**
   * The workspace the recorder's recordings go to: while one records, the
   * workspace it started in, even after the person moved to another one.
   * Absent from stores made before it existed.
   */
  workspaceId?: () => string | null;
  /**
   * Open a recorded meeting in its own workspace, through the host's
   * `onOpenMeeting`. False when the host gave no way to.
   */
  openMeeting?: (recordingId: string, workspaceId: string) => boolean;
};

export function createMeetingRecorderStore(
  onActivate: () => void = () => {},
  onOpenMeeting: (recordingId: string, workspaceId: string) => boolean = () => false,
): MeetingRecorderStore {
  let current: MeetingRecorder | null = null;
  let currentWorkspaceId: string | null = null;
  let finished: string[] = [];
  let pending: MeetingStartRequest | null = null;
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
    set: (recorder, workspaceId = null) => {
      current = recorder;
      currentWorkspaceId = recorder ? workspaceId : null;
      notify();
    },
    workspaceId: () => currentWorkspaceId,
    finished: () => finished,
    markFinished: (recordingId) => {
      finished = [...finished.filter((id) => id !== recordingId), recordingId];
      notify();
    },
    pendingStart: () => pending,
    requestStart: (request) => {
      pending = request;
      onActivate();
      notify();
    },
    takeStart: () => {
      const request = pending;
      if (request) {
        pending = null;
        notify();
      }
      return request;
    },
    activate: onActivate,
    openMeeting: (recordingId, workspaceId) => onOpenMeeting(recordingId, workspaceId),
  };
}

const MeetingRecorderContext = createContext<MeetingRecorderStore | null>(null);

export const MeetingRecorderStoreProvider = MeetingRecorderContext.Provider;

const LazyRecorderHost = lazy(() => import("./recorder-host"));

const RECORDING_DATABASE = "opengeni-recordings";

/** States in which the recorder holds a capture that unmounting its host would end. */
function capturing(state: MeetingRecorder["state"] | null | undefined): boolean {
  return (
    state === "starting" || state === "recording" || state === "paused" || state === "stopping"
  );
}

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
  scope,
  client,
  onOpenMeetings,
  onOpenMeeting,
  children,
}: {
  /** The workspace recordings go to; null while the host is still finding it. */
  workspaceId: string | null;
  /**
   * Who records, such as the signed-in person's id, for a host that mounts
   * this above sign-in. A new value ends a recording at once and starts a
   * fresh recorder; null means nobody is signed in, so there is no recorder.
   * Omit it when the host remounts the provider when the person changes.
   */
  scope?: string | null | undefined;
  /**
   * The SDK client the recorder uploads with, for a host that mounts this
   * above its routes without an <OpenGeniProvider> there. The provider's
   * client otherwise.
   */
  client?: object | undefined;
  /** Show the Meetings page, where a desktop call notification's recording starts. */
  onOpenMeetings?: (() => void) | undefined;
  /**
   * Show one meeting, after a desktop call notification stopped its recording
   * or a recording made in another workspace stopped. `workspaceId` is the
   * workspace the meeting is in, which may not be the one shown.
   */
  onOpenMeeting?: ((recordingId: string, workspaceId: string) => void) | undefined;
  children: ReactNode;
}) {
  const [active, setActive] = useState(false);
  const openMeeting = useRef(onOpenMeeting);
  useEffect(() => {
    openMeeting.current = onOpenMeeting;
  });
  const store = useMemo(
    () =>
      createMeetingRecorderStore(
        () => setActive(true),
        (recordingId, recordingWorkspaceId) => {
          if (!openMeeting.current) return false;
          openMeeting.current(recordingId, recordingWorkspaceId);
          return true;
        },
      ),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    void hasLocalRecordings().then((found) => {
      if (found && !cancelled) setActive(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useDesktopMeetingRequests(store, {
    signedOut: scope === null,
    onOpenMeetings,
  });
  // A start someone asked for belongs to who was signed in then.
  useEffect(() => {
    store.takeStart();
  }, [store, scope]);
  // Leaving a workspace must not end a recording made in it: the host, and
  // with it the capture, stays in the recording's workspace until it stops,
  // then follows the host's current workspace. Another person (scope) gets a
  // fresh host at once, which ends the capture.
  const busy = useSyncExternalStore(
    store.subscribe,
    () => capturing(store.get()?.state),
    () => false,
  );
  const [host, setHost] = useState({ scope, workspaceId });
  if (host.scope !== scope || (!busy && host.workspaceId !== workspaceId)) {
    setHost({ scope, workspaceId });
  }
  const hostWorkspaceId = host.scope === scope ? host.workspaceId : workspaceId;
  return (
    <MeetingRecorderContext.Provider value={store}>
      {children}
      {active && scope !== null && hostWorkspaceId ? (
        <Suspense fallback={null}>
          <LazyRecorderHost
            key={`${scope ?? ""}:${hostWorkspaceId}`}
            store={store}
            workspaceId={hostWorkspaceId}
            client={client}
          />
        </Suspense>
      ) : null}
    </MeetingRecorderContext.Provider>
  );
}

const NO_FINISHED: readonly string[] = [];

/**
 * The desktop app's call notifications: "Record" opens Meetings and starts
 * recording the call; "Stop" (the call ended) stops and opens the meeting.
 */
function useDesktopMeetingRequests(
  store: MeetingRecorderStore,
  navigation: { signedOut: boolean; onOpenMeetings?: (() => void) | undefined },
): void {
  const latest = useRef(navigation);
  useEffect(() => {
    latest.current = navigation;
  });
  useEffect(() => {
    // The bridge itself, not the app layer's helper, which would bring every
    // contract into this module, mounted above a host's routes.
    const bridge = getDesktopBridge();
    const detection = hasDesktopCapability(bridge, "meetingDetection")
      ? bridge?.meetingDetection
      : undefined;
    if (!detection) return;
    return detection.onRequest((request) => {
      const recorder = store.get();
      if (request.kind === "record") {
        // Nobody signed in: a start kept for later would record, for whoever
        // signs in next, a call that may be long over.
        if (latest.current.signedOut) return;
        // Already recording shows that recording rather than start a second one.
        if (!recorder || recorder.state === "idle") store.requestStart({ title: request.title });
        latest.current.onOpenMeetings?.();
        return;
      }
      const recordingId = recorder?.recordingId ?? null;
      const recordingWorkspaceId = store.workspaceId?.() ?? null;
      if (!recorder || (recorder.state !== "recording" && recorder.state !== "paused")) return;
      void recorder.stop().then(() => {
        if (recordingId && recordingWorkspaceId) {
          store.openMeeting?.(recordingId, recordingWorkspaceId);
        }
      });
    });
  }, [store]);
}

/** The start a desktop notification asked for, until the recorder panel takes it. */
export function usePendingMeetingStart(): {
  request: MeetingStartRequest | null;
  take: () => MeetingStartRequest | null;
} {
  const store = useContext(MeetingRecorderContext);
  const request = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.pendingStart ?? nullSnapshot,
    nullSnapshot,
  );
  return { request, take: store?.takeStart ?? nullSnapshot };
}

/** The live recorder, loading it on first use. Null until the capture code is ready. */
export function useMeetingRecorder(): {
  recorder: MeetingRecorder | null;
  finished: readonly string[];
  /** The workspace the recorder's recording is in; may differ from the one shown. */
  workspaceId: string | null;
  /**
   * Open a meeting the recorder made in its own workspace. False when the
   * host gave no way to, so the caller opens it as usual.
   */
  openMeeting: (recordingId: string, workspaceId: string) => boolean;
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
  const workspaceId = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.workspaceId ?? nullSnapshot,
    nullSnapshot,
  );
  return { recorder, finished, workspaceId, openMeeting: store?.openMeeting ?? neverOpens };
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

function neverOpens(): boolean {
  return false;
}
