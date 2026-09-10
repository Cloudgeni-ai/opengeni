export * from "./types";
export { pollDeviceAuthorization } from "./device";
export { findConnectRecoveryAccount } from "./recovery";
export { pollConnectAttempt } from "./poll";
export { authorizeConnectAttempt, type ConnectNavigation } from "./authorization";
export { createBrowserConnectNavigation, type ConnectBrowserWindow } from "./browser-navigation";
import type { ConnectAdvance, ConnectAttempt, ConnectOwnership, ConnectTransport } from "./types";
import { pollConnectAttempt } from "./poll";

export type ConnectSnapshot = {
  attempt: ConnectAttempt | null;
  busy: boolean;
  error: Error | null;
};

/** A transport-injected, framework-neutral view of one durable setup attempt.
 * OAuth redirects are hints to navigate; completion is read from the backend.
 * Secret form values are never stored in a snapshot or browser persistence. */
export class ConnectController {
  private snapshot: ConnectSnapshot = Object.freeze({ attempt: null, busy: false, error: null });
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private request: AbortController | null = null;
  private disposed = false;

  constructor(
    readonly transport: ConnectTransport,
    readonly workspaceId: string,
  ) {
    if (!workspaceId) throw new Error("Connect requires an explicit workspace");
  }

  getSnapshot = (): ConnectSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.assertActive();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  begin(input: {
    providerId: string;
    ownership: ConnectOwnership;
    returnUrl: string;
    idempotencyKey: string;
    reconnectAccountId?: string;
    installationTarget?: import("./types").ConnectInstallationTarget;
  }): Promise<ConnectAttempt> {
    // Validation must not serialize or decorate the host's exact return string.
    const url = new URL(input.returnUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Connect return URL must be an HTTP(S) destination without credentials");
    }
    return this.run((signal) => this.transport.begin(this.workspaceId, input, { signal }), true);
  }

  recover(attemptId: string): Promise<ConnectAttempt> {
    if (!attemptId) throw new Error("Connect recovery requires an attempt ID");
    return this.run(
      (signal) => this.transport.get(this.workspaceId, attemptId, { signal }),
      true,
      attemptId,
    );
  }

  refresh(): Promise<ConnectAttempt> {
    const attempt = this.requireAttempt();
    if (this.snapshot.busy) throw new Error("A Connect operation is already in progress");
    return this.run(
      (signal) => this.transport.get(this.workspaceId, attempt.id, { signal }),
      false,
      attempt.id,
    );
  }

  advance(action: ConnectAdvance, idempotencyKey: string): Promise<ConnectAttempt> {
    const attempt = this.requireAttempt();
    if (this.snapshot.busy) throw new Error("A Connect operation is already in progress");
    return this.run(
      (signal) =>
        this.transport.advance(
          this.workspaceId,
          attempt.id,
          {
            expectedRevision: attempt.revision,
            idempotencyKey,
            action,
          },
          { signal },
        ),
      false,
      attempt.id,
    );
  }

  /** Observe backend progress without replaying a setup mutation. Disposal or
   * selecting another attempt aborts the read loop and fences its late result. */
  waitForAction(options: { timeoutMs?: number } = {}): Promise<ConnectAttempt> {
    const attempt = this.requireAttempt();
    if (this.snapshot.busy) throw new Error("A Connect operation is already in progress");
    return this.run(
      (signal) =>
        pollConnectAttempt(this.transport, this.workspaceId, attempt.id, {
          ...options,
          signal,
          minimumRevision: attempt.revision,
        }),
      false,
      attempt.id,
    );
  }

  cancel(idempotencyKey: string): Promise<ConnectAttempt> {
    const attempt = this.requireAttempt();
    if (this.snapshot.busy) throw new Error("A Connect operation is already in progress");
    return this.run(
      (signal) =>
        this.transport.cancel(
          this.workspaceId,
          attempt.id,
          {
            expectedRevision: attempt.revision,
            idempotencyKey,
          },
          { signal },
        ),
      false,
      attempt.id,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.request?.abort();
    this.request = null;
    this.listeners.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Connect controller is disposed");
  }
  private requireAttempt(): ConnectAttempt {
    this.assertActive();
    if (!this.snapshot.attempt) throw new Error("No Connect attempt is selected");
    return this.snapshot.attempt;
  }
  private publish(snapshot: ConnectSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
  private async run(
    operation: (signal: AbortSignal) => Promise<ConnectAttempt>,
    replace: boolean,
    expectedId?: string,
  ): Promise<ConnectAttempt> {
    this.assertActive();
    const generation = ++this.generation;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.publish({ attempt: replace ? null : this.snapshot.attempt, busy: true, error: null });
    try {
      const result = await operation(request.signal);
      if (generation !== this.generation || this.disposed)
        throw new Error("Connect operation was superseded");
      if (result.workspaceId !== this.workspaceId || (expectedId && result.id !== expectedId)) {
        throw new Error("Connect response scope mismatch");
      }
      if (
        !Number.isSafeInteger(result.revision) ||
        result.revision < 1 ||
        (this.snapshot.attempt?.id === result.id &&
          result.revision < this.snapshot.attempt.revision)
      ) {
        throw new Error("Connect response revision is stale");
      }
      const attempt = freezeTree(structuredClone(result));
      this.publish({ attempt, busy: false, error: null });
      return structuredClone(attempt);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Connect operation failed");
      if (generation === this.generation && !this.disposed) {
        // Transport errors can retain request bodies, headers, nested causes or
        // echoed credentials. Keep only a fixed, credential-free UI error in
        // the long-lived snapshot; direct callers still receive the rejection.
        this.publish({
          attempt: this.snapshot.attempt,
          busy: false,
          error: Object.freeze(
            new Error("Connect operation failed; refresh its status before retrying"),
          ),
        });
      }
      throw error;
    } finally {
      if (generation === this.generation) this.request = null;
    }
  }
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
