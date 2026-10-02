import { formatErrorMessage } from "@opengeni/sdk";
import { createContext, useCallback, useContext } from "react";

/** Original diagnostic error and the library's neutral, state-aware display copy. */
export type ErrorMessageFormatter = (error: unknown, defaultMessage: string) => string | undefined;

export const ErrorMessageContext = createContext<ErrorMessageFormatter | undefined>(undefined);

/** Presentation only: callers retain their errors and delivery/retry state. */
export function useErrorMessage(): (error: unknown, defaultMessage?: string) => string {
  const formatter = useContext(ErrorMessageContext);
  return useCallback(
    (error, defaultMessage = formatErrorMessage(error)) =>
      formatter?.(error, defaultMessage) || defaultMessage,
    [formatter],
  );
}
