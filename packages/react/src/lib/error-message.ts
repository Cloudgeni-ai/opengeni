import { formatErrorMessage } from "@opengeni/sdk";
import { createContext, useCallback, useContext, useRef } from "react";

/** Original diagnostic error and the library's neutral, state-aware display copy. */
export type ErrorMessageFormatter = (error: unknown, defaultMessage: string) => string | undefined;

export const ErrorMessageContext = createContext<ErrorMessageFormatter | undefined>(undefined);

const originalCauses = new WeakMap<Error, unknown>();

/** Keep existing Error-typed state while retaining non-Error rejections privately. */
export function normalizeError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const error = new Error(String(cause));
  originalCauses.set(error, cause);
  return error;
}

/** Presentation only: callers retain their errors and delivery/retry state. */
export function useErrorMessage(): (error: unknown, defaultMessage?: string) => string {
  const formatter = useContext(ErrorMessageContext);
  const formatterRef = useRef(formatter);
  formatterRef.current = formatter;
  return useCallback((error, fallback) => {
    const original =
      error instanceof Error && originalCauses.has(error) ? originalCauses.get(error) : error;
    const defaultMessage = fallback ?? formatErrorMessage(original);
    try {
      const message = formatterRef.current?.(original, defaultMessage);
      return typeof message === "string" && message ? message : defaultMessage;
    } catch {
      // Host presentation must never interrupt delivery-state settlement or
      // cause an already-started mutation to be retried.
      return defaultMessage;
    }
  }, []);
}
