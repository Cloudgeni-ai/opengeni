import { isMaintenanceError } from "@opengeni/sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  isCalmServiceFailure,
  isTransientServiceFailure,
  SERVICE_UPDATING_CALM_WINDOW_MS,
} from "./transient-retry";

/**
 * Whether `error` is currently calm. The window starts when a transient error
 * first appears, is held while the maintenance marker lasts, and ends with a
 * re-render once it expires so a lasting failure surfaces on its own.
 */
export function useCalmServiceFailure(error: Error | null | undefined): boolean {
  const sinceRef = useRef<number | null>(null);
  const [, setExpired] = useState(0);
  const transient = error ? isTransientServiceFailure(error) : false;
  const maintenance = error ? isMaintenanceError(error) : false;
  const now = Date.now();
  if (!transient) sinceRef.current = null;
  else if (maintenance || sinceRef.current === null) sinceRef.current = now;
  const since = sinceRef.current;
  const calm = since !== null && error ? isCalmServiceFailure(error, since, now) : false;
  useEffect(() => {
    if (!calm || maintenance || since === null) return;
    const timer = setTimeout(
      () => setExpired((value) => value + 1),
      Math.max(0, since + SERVICE_UPDATING_CALM_WINDOW_MS - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [calm, maintenance, since]);
  return calm;
}

/**
 * `flag`, but only once it has held for `delayMs`; it drops immediately. Keeps
 * a brief reconnect from flashing a status.
 */
export function useDelayedFlag(flag: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!flag) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, flag]);
  return flag && shown;
}

/** How long a dropped event stream may reconnect before the composer says so. */
export const STREAM_RECONNECTING_NOTICE_DELAY_MS = 2_000;

/**
 * True once the session's event stream has been reconnecting for a moment
 * after the first load: Opengeni is updating or briefly unreachable. A quick
 * reconnect never shows.
 */
export function useStreamReconnecting(
  connectionState: string | undefined,
  initialLoading: boolean,
): boolean {
  return useDelayedFlag(
    connectionState === "reconnecting" || (connectionState === "connecting" && !initialLoading),
    STREAM_RECONNECTING_NOTICE_DELAY_MS,
  );
}

/**
 * The composer state with `reconnecting` set while the event stream is
 * reconnecting, so the composer shows the calm updating line.
 */
export function useComposerWithStreamState<T extends { reconnecting?: boolean | undefined }>(
  composer: T,
  connectionState: string | undefined,
  initialLoading: boolean,
): T {
  const streamReconnecting = useStreamReconnecting(connectionState, initialLoading);
  return useMemo(
    () =>
      streamReconnecting && composer.reconnecting !== true
        ? { ...composer, reconnecting: true }
        : composer,
    [composer, streamReconnecting],
  );
}
