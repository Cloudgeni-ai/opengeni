import type { SiteToolConsentDecision, SiteToolConsentPrompt } from "@opengeni/sdk/site";
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ConnectRequest } from "./site-tool-consent-dialog";

// The dialog code loads only when a Site first asks (the eager-graph budget).
const SiteToolConsentDialog = lazy(() =>
  import("./site-tool-consent-dialog").then((module) => ({
    default: module.SiteToolConsentDialog,
  })),
);
const SiteToolConnect = lazy(() =>
  import("./site-tool-consent-dialog").then((module) => ({ default: module.SiteToolConnect })),
);

/** Questions waiting at once; a Site that keeps calling is refused beyond this. */
const MAX_PENDING = 8;

type Pending = { id: number } & (
  | {
      kind: "confirm";
      prompt: SiteToolConsentPrompt;
      done: (value: SiteToolConsentDecision) => void;
    }
  | { kind: "connect"; prompt: ConnectRequest; done: (value: boolean) => void }
);
export type SiteToolConsentHost = {
  confirmToolCall: (prompt: SiteToolConsentPrompt) => Promise<SiteToolConsentDecision>;
  connectForToolCall: (prompt: ConnectRequest) => Promise<boolean>;
};
const SiteToolConsentContext = createContext<SiteToolConsentHost | null>(null);

/** Asks for every Site in the console, one confirmation at a time. */
export function SiteToolConsentProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const queued = useRef<Pending[]>([]);
  const nextId = useRef(0);
  const settle = useCallback((item: Pending, value: SiteToolConsentDecision | boolean) => {
    if (!queued.current.includes(item)) return;
    queued.current = queued.current.filter((candidate) => candidate !== item);
    setQueue(queued.current);
    if (item.kind === "confirm") item.done(value as SiteToolConsentDecision);
    else item.done(value as boolean);
  }, []);
  useEffect(
    () => () => {
      for (const item of queued.current) settle(item, item.kind === "confirm" ? null : false);
    },
    [settle],
  );
  const enqueue = useCallback(
    <T,>(
      make: (done: (value: T) => void, id: number) => Pending,
      signal: AbortSignal,
      cancelled: T,
    ) =>
      new Promise<T>((resolve) => {
        if (signal.aborted || queued.current.length >= MAX_PENDING) return resolve(cancelled);
        const item = make(resolve, (nextId.current += 1));
        // The Site stopped waiting (closed, timed out): withdraw the question.
        signal.addEventListener("abort", () => settle(item, cancelled as never), { once: true });
        queued.current = [...queued.current, item];
        setQueue(queued.current);
      }),
    [settle],
  );
  const host = useMemo<SiteToolConsentHost>(
    () => ({
      confirmToolCall: (prompt) =>
        enqueue<SiteToolConsentDecision>(
          (done, id) => ({ id, kind: "confirm", prompt, done }),
          prompt.signal,
          null,
        ),
      connectForToolCall: (prompt) =>
        enqueue<boolean>(
          (done, id) => ({ id, kind: "connect", prompt, done }),
          prompt.signal,
          false,
        ),
    }),
    [enqueue],
  );
  const current = queue[0];
  return (
    <SiteToolConsentContext.Provider value={host}>
      {children}
      <Suspense fallback={null}>
        {current?.kind === "confirm" ? (
          <SiteToolConsentDialog
            key={current.id}
            prompt={current.prompt}
            onDecision={(decision) => settle(current, decision)}
          />
        ) : current?.kind === "connect" ? (
          <SiteToolConnect
            key={current.id}
            request={current.prompt}
            onDone={(ok) => settle(current, ok)}
          />
        ) : null}
      </Suspense>
    </SiteToolConsentContext.Provider>
  );
}

/** The console's consent host, or null outside `SiteToolConsentProvider`. */
export const useSiteToolConsentHost = () => useContext(SiteToolConsentContext);
