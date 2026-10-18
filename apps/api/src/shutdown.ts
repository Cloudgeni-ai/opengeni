type ShutdownSignal = "SIGINT" | "SIGTERM";
type ShutdownProcess = {
  on(signal: ShutdownSignal, handler: () => void): unknown;
  off(signal: ShutdownSignal, handler: () => void): unknown;
  exit(code: number): void;
};

/** Standalone process boundary; embedded hosts keep owning their explicit close(). */
export function installApiShutdownHandlers(input: {
  close: () => Promise<void>;
  process?: ShutdownProcess;
  timeoutMs?: number;
  onFailure?: () => void;
}): () => void {
  const runtime = input.process ?? process;
  let started = false;
  let finished = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    runtime.off("SIGINT", shutdown);
    runtime.off("SIGTERM", shutdown);
  };
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    dispose();
    if (code !== 0) {
      try {
        input.onFailure?.();
      } catch {
        /* Observability cannot prevent exit. */
      }
    }
    runtime.exit(code);
  };
  function shutdown() {
    if (started) return;
    started = true;
    deadline = setTimeout(() => finish(1), input.timeoutMs ?? 30_000);
    deadline.unref?.();
    // Catch synchronous close failures as well. Duplicate signals never start a
    // second logout or race the connection pool's credential/session cleanup.
    void Promise.resolve()
      .then(input.close)
      .then(
        () => finish(0),
        () => finish(1),
      );
  }
  runtime.on("SIGINT", shutdown);
  runtime.on("SIGTERM", shutdown);
  return dispose;
}
