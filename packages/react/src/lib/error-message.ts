import { formatErrorMessage } from "@opengeni/sdk";
import { createContext, useCallback, useContext, useRef } from "react";

/** Original diagnostic error and the library's neutral, state-aware display copy. */
export type ErrorMessageFormatter = (error: unknown, defaultMessage: string) => string | undefined;

export const ErrorMessageContext = createContext<ErrorMessageFormatter | undefined>(undefined);

/** Presentation only: callers retain their errors and delivery/retry state. */
export function useErrorMessage(): (error: unknown, defaultMessage?: string) => string {
  const formatter = useContext(ErrorMessageContext);
  const formatterRef = useRef(formatter);
  formatterRef.current = formatter;
  return useCallback((error, defaultMessage = formatErrorMessage(error)) => {
    try {
      const message = formatterRef.current?.(error, defaultMessage);
      return typeof message === "string" && message ? message : defaultMessage;
    } catch {
      // Host presentation must never interrupt delivery-state settlement or
      // cause an already-started mutation to be retried.
      return defaultMessage;
    }
  }, []);
}
