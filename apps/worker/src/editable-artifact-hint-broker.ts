import {
  EDITABLE_ARTIFACT_HINT_MAX_BYTES,
  type EditableArtifactHintBrokerPort,
} from "@opengeni/core";
import { connect, type NatsConnection } from "@opengeni/events";

const DEFAULT_CONNECTION_NAME = "opengeni-editable-artifact-outbox";

export type EditableArtifactHintNatsAuth =
  | Readonly<{ kind: "user-password"; user: string; pass: string }>
  | Readonly<{ kind: "token"; token: string }>
  | Readonly<{ kind: "anonymous" }>;

export type EditableArtifactHintNatsBrokerOptions = Readonly<{
  maxHintBytes?: number;
}>;

export type EditableArtifactHintNatsConnection = Pick<
  NatsConnection,
  "publish" | "flush" | "drain" | "close" | "closed" | "isClosed" | "isDraining"
>;

/**
 * Core-NATS adapter for the durable outbox. A publish resolves only after a
 * server round-trip flush ACK. Reconnect buffering may create duplicates after
 * a timeout; hints are intentionally idempotent wakeups for durable gap-fill.
 */
export class ConfirmedNatsEditableArtifactHintBroker implements EditableArtifactHintBrokerPort {
  private readonly maxHintBytes: number;

  constructor(
    private readonly connection: EditableArtifactHintNatsConnection,
    options: EditableArtifactHintNatsBrokerOptions = {},
  ) {
    this.maxHintBytes = options.maxHintBytes ?? EDITABLE_ARTIFACT_HINT_MAX_BYTES;
    if (
      !Number.isSafeInteger(this.maxHintBytes) ||
      this.maxHintBytes < 1 ||
      this.maxHintBytes > EDITABLE_ARTIFACT_HINT_MAX_BYTES
    ) {
      throw new TypeError("Editable artifact NATS hint byte limit is invalid");
    }
  }

  async publish(
    input: Readonly<{
      subject: string;
      payload: Uint8Array;
      signal: AbortSignal;
    }>,
  ): Promise<void> {
    assertSubject(input.subject);
    if (
      !(input.payload instanceof Uint8Array) ||
      input.payload.byteLength < 1 ||
      input.payload.byteLength > this.maxHintBytes
    ) {
      throw new EditableArtifactNatsHintPublishError(
        "broker_backpressure",
        "Editable artifact hint exceeds the NATS envelope",
      );
    }
    if (input.signal.aborted) throw abortedPublish();
    if (this.connection.isClosed() || this.connection.isDraining()) {
      throw new EditableArtifactNatsHintPublishError(
        "broker_unavailable",
        "Editable artifact NATS connection is closed",
      );
    }
    try {
      this.connection.publish(input.subject, input.payload);
      await abortable(this.connection.flush(), input.signal);
    } catch (error) {
      if (input.signal.aborted) throw abortedPublish();
      if (error instanceof EditableArtifactNatsHintPublishError) throw error;
      throw new EditableArtifactNatsHintPublishError(
        "broker_unavailable",
        "Editable artifact NATS publish was not acknowledged",
        { cause: error },
      );
    }
  }

  /**
   * A readiness probe must prove the server is reachable, not merely that the
   * client object has not observed closure yet. `flush()` is a bounded NATS
   * round trip and has the same acknowledgement semantics as publication.
   */
  async check(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (signal.aborted) throw abortedPublish();
    if (this.connection.isClosed() || this.connection.isDraining()) {
      throw new EditableArtifactNatsHintPublishError(
        "broker_unavailable",
        "Editable artifact NATS connection is unavailable",
      );
    }
    try {
      await abortable(this.connection.flush(), signal);
    } catch (error) {
      if (error instanceof EditableArtifactNatsHintPublishError) throw error;
      throw new EditableArtifactNatsHintPublishError(
        "broker_unavailable",
        "Editable artifact NATS readiness round trip failed",
        { cause: error },
      );
    }
  }

  async close(drainTimeoutMs = 5_000): Promise<void> {
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 30_000) {
      throw new TypeError("Editable artifact NATS drain timeout is invalid");
    }
    if (this.connection.isClosed()) return;
    if (this.connection.isDraining()) {
      await this.connection.closed();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = this.connection.drain();
    const outcome = await Promise.race([
      drain.then(
        () => "drained" as const,
        () => "failed" as const,
      ),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), drainTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome !== "drained" && !this.connection.isClosed()) {
      await this.connection.close();
    }
  }
}

export class EditableArtifactNatsHintPublishError extends Error {
  constructor(
    readonly code: "broker_unavailable" | "broker_backpressure",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EditableArtifactNatsHintPublishError";
  }
}

/** Opens one resilient dispatcher identity; callers own `broker.close()`. */
export async function connectEditableArtifactHintBroker(
  input: Readonly<{
    natsUrl: string;
    auth: EditableArtifactHintNatsAuth;
    name?: string;
    maxHintBytes?: number;
  }>,
): Promise<ConfirmedNatsEditableArtifactHintBroker> {
  const natsUrl = boundedText(input.natsUrl, "NATS URL", 2_048);
  const name = boundedText(input.name ?? DEFAULT_CONNECTION_NAME, "NATS connection name", 128);
  const auth = natsAuthOptions(input.auth);
  const connection = await connect({
    servers: natsUrl,
    name,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2_000,
    reconnectJitter: 1_000,
    reconnectJitterTLS: 1_000,
    waitOnFirstConnect: true,
    pingInterval: 20_000,
    maxPingOut: 3,
    ...auth,
  });
  return new ConfirmedNatsEditableArtifactHintBroker(connection, {
    ...(input.maxHintBytes === undefined ? {} : { maxHintBytes: input.maxHintBytes }),
  });
}

function natsAuthOptions(auth: EditableArtifactHintNatsAuth): {
  user?: string;
  pass?: string;
  token?: string;
} {
  if (auth.kind === "anonymous") return {};
  if (auth.kind === "token") return { token: boundedText(auth.token, "NATS token", 4_096) };
  return {
    user: boundedText(auth.user, "NATS user", 256),
    pass: boundedText(auth.pass, "NATS password", 4_096),
  };
}

function assertSubject(subject: string): void {
  const bytes = new TextEncoder().encode(subject).byteLength;
  if (
    bytes < 1 ||
    bytes > 1_024 ||
    subject.startsWith(".") ||
    subject.endsWith(".") ||
    subject.includes("..") ||
    /[\s*>]/u.test(subject)
  ) {
    throw new EditableArtifactNatsHintPublishError(
      "broker_backpressure",
      "Editable artifact NATS subject is malformed",
    );
  }
}

function boundedText(value: string, label: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 1 || bytes > maxBytes || value.trim() !== value) {
    throw new TypeError(`${label} is malformed`);
  }
  return value;
}

function abortedPublish(): EditableArtifactNatsHintPublishError {
  return new EditableArtifactNatsHintPublishError(
    "broker_unavailable",
    "Editable artifact NATS publish was aborted",
  );
}

async function abortable(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortedPublish();
  let remove: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortedPublish());
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([operation, aborted]);
  } finally {
    remove();
  }
}
