export type EditableArtifactDomainErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "not_editable"
  | "idempotency_conflict"
  | "request_hash_mismatch"
  | "causal_future"
  | "causal_chain_conflict"
  | "stale_base"
  | "kernel_contract_violation"
  | "retryable_conflict"
  | "invalid_undo_target"
  | "snapshot_conflict"
  | "outbox_lease_conflict";

export class EditableArtifactDomainError extends Error {
  constructor(
    readonly code: EditableArtifactDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EditableArtifactDomainError";
  }
}

export class EditableArtifactNotFoundError extends EditableArtifactDomainError {
  constructor() {
    super("not_found", "Editable artifact was not found in the requested tenant scope");
  }
}

export class EditableArtifactInvalidRequestError extends EditableArtifactDomainError {
  constructor(message: string) {
    super("invalid_request", message);
  }
}

export class EditableArtifactForbiddenError extends EditableArtifactDomainError {
  constructor(permission: string) {
    super("forbidden", `Editable artifact permission denied: ${permission}`);
  }
}

export class EditableArtifactNotEditableError extends EditableArtifactDomainError {
  constructor(state: string) {
    super("not_editable", `Editable artifact cannot be changed while ${state}`);
  }
}

export class EditableArtifactIdempotencyConflictError extends EditableArtifactDomainError {
  constructor() {
    super(
      "idempotency_conflict",
      "Client transaction id was already committed with a different request hash",
    );
  }
}

export class EditableArtifactRequestHashMismatchError extends EditableArtifactDomainError {
  constructor() {
    super("request_hash_mismatch", "Request hash does not match the canonical transaction body");
  }
}

export class EditableArtifactCausalFutureError extends EditableArtifactDomainError {
  constructor() {
    super("causal_future", "Causal base references state beyond the authoritative frontier");
  }
}

export class EditableArtifactCausalChainError extends EditableArtifactDomainError {
  constructor(message: string) {
    super("causal_chain_conflict", message);
  }
}

export class EditableArtifactStaleBaseError extends EditableArtifactDomainError {
  constructor() {
    super(
      "stale_base",
      "Serialized editable artifact changed after this transaction observed its base",
    );
  }
}

export class EditableArtifactKernelContractError extends EditableArtifactDomainError {
  constructor(message: string) {
    super("kernel_contract_violation", message);
  }
}

export class EditableArtifactRetryableConflictError extends EditableArtifactDomainError {
  constructor() {
    super(
      "retryable_conflict",
      "Editable artifact changed repeatedly while applying the transaction; retry the same client transaction",
    );
  }
}

export class EditableArtifactUndoTargetError extends EditableArtifactDomainError {
  constructor(message: string) {
    super("invalid_undo_target", message);
  }
}

export class EditableArtifactSnapshotConflictError extends EditableArtifactDomainError {
  constructor(message: string) {
    super("snapshot_conflict", message);
  }
}

export class EditableArtifactOutboxLeaseConflictError extends EditableArtifactDomainError {
  constructor() {
    super("outbox_lease_conflict", "Live outbox record is not leased by this publisher");
  }
}
