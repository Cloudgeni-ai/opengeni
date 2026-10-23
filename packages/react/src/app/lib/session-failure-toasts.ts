import { useEffect } from "react";

import { useCalmServiceFailure } from "../../lib/use-calm-service-failure";
import { isApiErrorStatus } from "./app-api";
import { toast } from "./toast";

/**
 * Toast the session page's read failures, once per error. The read hooks keep
 * transient failures (a rolling deploy, a network blip) quiet while they retry
 * and keep one stable error per outage, so an error reaches here only when it
 * is definitive or outlasted the quiet window. A transient one still waits out
 * the calm update window (and the maintenance marker never toasts): Opengeni is
 * updating and the page reconnects by itself. A 404 renders the unavailable
 * route instead of a toast.
 */
export function useSessionFailureToasts(loadError: Error | null, streamError: Error | null): void {
  const streamCalm = useCalmServiceFailure(streamError);
  const loadCalm = useCalmServiceFailure(loadError);
  useEffect(() => {
    if (streamError && !streamCalm && !isApiErrorStatus(streamError, 404)) {
      toast.error("Event stream disconnected", {
        description: streamError.message,
      });
    }
  }, [streamCalm, streamError]);
  useEffect(() => {
    if (loadError && !loadCalm && !isApiErrorStatus(loadError, 404)) {
      toast.error("Failed to load session", { description: String(loadError) });
    }
  }, [loadCalm, loadError]);
}
