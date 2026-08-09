export type EditableArtifactSyncErrorCode =
  | "unsupported_protocol"
  | "invalid_bootstrap"
  | "invalid_sequence"
  | "kernel_diverged"
  | "queue_overflow"
  | "resync_required"
  | "permission_changed"
  | "storage_failed"
  | "pending_conflict"
  | "reconnect_exhausted";

export class EditableArtifactSyncError extends Error {
  readonly code: EditableArtifactSyncErrorCode;
  readonly retryable: boolean;
  readonly requiresSnapshot: boolean;

  constructor(
    code: EditableArtifactSyncErrorCode,
    message: string,
    options: { retryable?: boolean; requiresSnapshot?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EditableArtifactSyncError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.requiresSnapshot = options.requiresSnapshot ?? false;
  }
}

/** Transport adapters wrap retryable network failures in this typed error. */
export class EditableArtifactTransportError extends Error {
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    options: {
      code?: string;
      retryable?: boolean;
      outcomeUnknown?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EditableArtifactTransportError";
    this.code = options.code;
    this.retryable = options.retryable ?? true;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}
