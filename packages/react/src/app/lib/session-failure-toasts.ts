import { useEffect } from "react";

import { isApiErrorStatus } from "./app-api";
import { toast } from "./toast";

/**
 * Toast the session page's read failures, once per error. The read hooks keep
 * transient failures (a rolling deploy, a network blip) quiet while they retry
 * and keep one stable error per outage, so an error reaches here only when it
 * is definitive or outlasted the quiet window. A 404 renders the unavailable
 * route instead of a toast.
 */
export function useSessionFailureToasts(loadError: Error | null, streamError: Error | null): void {
  useEffect(() => {
    if (streamError && !isApiErrorStatus(streamError, 404)) {
      toast.error("Event stream disconnected", {
        description: streamError.message,
      });
    }
  }, [streamError]);
  useEffect(() => {
    if (loadError && !isApiErrorStatus(loadError, 404)) {
      toast.error("Failed to load session", { description: String(loadError) });
    }
  }, [loadError]);
}
