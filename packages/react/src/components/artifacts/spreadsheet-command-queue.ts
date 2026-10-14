import { useCallback, useEffect, useRef, useState } from "react";

export type SpreadsheetCommandTarget = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

type Command = {
  id: number;
  target: SpreadsheetCommandTarget | null;
  overlapped: boolean;
  covered: boolean;
  message?: string;
  retry?: () => void;
};

function overlaps(a: SpreadsheetCommandTarget, b: SpreadsheetCommandTarget): boolean {
  return a.top <= b.bottom && a.bottom >= b.top && a.left <= b.right && a.right >= b.left;
}

function contains(a: SpreadsheetCommandTarget, b: SpreadsheetCommandTarget): boolean {
  return a.top <= b.top && a.bottom >= b.bottom && a.left <= b.left && a.right >= b.right;
}

/** Keep independent failures visible without replaying over newer overlapping edits. */
export function useSpreadsheetCommandQueue({
  scopeKey,
  enabled,
  onCommandError,
}: {
  scopeKey: string;
  enabled: boolean;
  onCommandError?: ((error: Error) => void) | undefined;
}) {
  const [pendingCount, setPendingCount] = useState(0);
  const [failures, setFailures] = useState<readonly Command[]>([]);
  const commandsRef = useRef(new Map<number, Command>());
  const nextIdRef = useRef(0);
  const mountedRef = useRef(true);
  const optionsRef = useRef({ scopeKey, enabled, onCommandError });
  optionsRef.current = { scopeKey, enabled, onCommandError };
  const scopeRef = useRef({ key: scopeKey, epoch: 0 });
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current = { key: scopeKey, epoch: scopeRef.current.epoch + 1 };
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    commandsRef.current.clear();
    setPendingCount(0);
    setFailures([]);
  }, [scopeKey]);

  const refreshFailures = useCallback(() => {
    setFailures(
      [...commandsRef.current.values()].filter(
        (command) => command.message !== undefined && !command.covered,
      ),
    );
  }, []);

  const clearPreflightFailure = useCallback(() => {
    let changed = false;
    for (const previous of commandsRef.current.values()) {
      if (previous.target === null && previous.message !== undefined) {
        commandsRef.current.delete(previous.id);
        changed = true;
      }
    }
    if (changed) refreshFailures();
  }, [refreshFailures]);

  const run = useCallback(
    (
      invoke: (id: number) => void | Promise<void>,
      retry: () => void,
      rollback: (id: number) => void,
      target?: SpreadsheetCommandTarget | (() => SpreadsheetCommandTarget),
      accepted?: (id: number) => void,
    ) => {
      if (!optionsRef.current.enabled) return;
      const scope = optionsRef.current.scopeKey;
      const epoch = scopeRef.current.epoch;
      const id = ++nextIdRef.current;
      // A preflight failure never authored a range, so the next action replaces
      // it. Authored independent failures remain until retried or superseded.
      clearPreflightFailure();
      const command: Command = { id, target: null, overlapped: false, covered: false };
      commandsRef.current.set(id, command);
      const current = () =>
        mountedRef.current &&
        optionsRef.current.scopeKey === scope &&
        scopeRef.current.epoch === epoch;
      const fail = (cause: unknown) => {
        if (!current()) return;
        rollback(id);
        if (command.covered) {
          commandsRef.current.delete(id);
          return;
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        command.message = error.message || "Spreadsheet change failed";
        command.retry = () => {
          if (!current() || !optionsRef.current.enabled || command.overlapped) return;
          commandsRef.current.delete(id);
          refreshFailures();
          retry();
        };
        refreshFailures();
        optionsRef.current.onCommandError?.(error);
      };
      let result: void | Promise<void>;
      try {
        command.target = typeof target === "function" ? target() : (target ?? null);
        if (command.target) {
          for (const previous of commandsRef.current.values()) {
            if (
              previous.id === id ||
              !previous.target ||
              !overlaps(command.target, previous.target)
            )
              continue;
            previous.overlapped = true;
            previous.covered ||= contains(command.target, previous.target);
            if (previous.covered && previous.message !== undefined)
              commandsRef.current.delete(previous.id);
          }
          refreshFailures();
        }
        result = invoke(id);
      } catch (cause) {
        fail(cause);
        return;
      }
      const succeed = () => {
        if (!current()) return;
        commandsRef.current.delete(id);
        accepted?.(id);
      };
      if (!result || typeof result.then !== "function") {
        succeed();
        return;
      }
      setPendingCount((count) => count + 1);
      void Promise.resolve(result).then(
        () => {
          if (!current()) return;
          setPendingCount((count) => Math.max(0, count - 1));
          succeed();
        },
        (cause) => {
          if (!current()) return;
          setPendingCount((count) => Math.max(0, count - 1));
          fail(cause);
        },
      );
    },
    [clearPreflightFailure, refreshFailures],
  );

  const first = failures[0];
  return {
    run,
    clearPreflightFailure,
    pendingCount,
    error: first
      ? {
          message:
            failures.length > 1
              ? `${first.message} (${failures.length} changes not saved)`
              : first.message!,
          retry: enabled && !first.overlapped ? first.retry : undefined,
        }
      : null,
  };
}
