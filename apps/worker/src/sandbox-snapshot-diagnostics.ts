import { sandboxLeaseTelemetryKey, type Observability } from "@opengeni/observability";

type SafeSnapshotError = {
  errorClass: "SnapshotOperationError";
  errorCode: "snapshot_operation_failed";
  status?: number;
  origin: "sandbox-resume" | "worker-lifecycle";
  causeName?: string;
  integrityCode?: string;
  providerErrorName?: string;
  providerGrpcCode?: number;
  providerHttpStatus?: number;
  providerRetryable?: boolean;
};

export function safeSnapshotError(
  error: unknown,
  origin: SafeSnapshotError["origin"] = "sandbox-resume",
): SafeSnapshotError {
  const fields: SafeSnapshotError = {
    errorClass: "SnapshotOperationError",
    errorCode: "snapshot_operation_failed",
    origin,
  };
  try {
    if (error && typeof error === "object") {
      const candidate = error as {
        name?: unknown;
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
      };
      if (
        typeof candidate.name === "string" &&
        /^[A-Z][A-Za-z0-9]{2,62}Error$/u.test(candidate.name)
      ) {
        fields.causeName = candidate.name;
      }
      if (typeof candidate.code === "string" && /^[a-z0-9_]{1,64}$/u.test(candidate.code)) {
        fields.integrityCode = candidate.code;
      }
      const status = Number(candidate.status ?? candidate.statusCode);
      if (Number.isInteger(status) && status >= 100 && status <= 599) fields.status = status;
    }
  } catch {
    // Diagnostics must never replace the exact internal snapshot failure.
  }
  // The SDK wraps provider classification in details, not Error.cause. Never
  // project free-form messages, causes, request IDs or payloads. Read fields
  // independently so a hostile getter cannot hide other safe classifications.
  const read = (value: unknown, key: string): unknown => {
    try {
      return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
    } catch {
      return undefined;
    }
  };
  const details = read(error, "details");
  const providerName = read(details, "errorName");
  if (
    typeof providerName === "string" &&
    [
      "ClientError",
      "TimeoutError",
      "ConnectionError",
      "AuthError",
      "NotFoundError",
      "InvalidError",
      "RemoteError",
      "AbortError",
    ].includes(providerName)
  )
    fields.providerErrorName = providerName;
  const grpcCode = read(details, "errorCode");
  if (
    providerName === "ClientError" &&
    typeof grpcCode === "number" &&
    Number.isInteger(grpcCode) &&
    grpcCode >= 0 &&
    grpcCode <= 16
  )
    fields.providerGrpcCode = grpcCode;
  for (const key of ["status", "httpStatus", "responseStatus"]) {
    const status = read(details, key);
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      fields.providerHttpStatus = status;
      break;
    }
  }
  const retryable = read(error, "retryable");
  if (typeof retryable === "boolean") fields.providerRetryable = retryable;
  return fields;
}

export function warnDrainSnapshotFailure(
  observability: Pick<Observability, "warn">,
  message: string,
  error: unknown,
  lease: { workspaceId?: string; sandboxGroupId: string; leaseEpoch: number },
): void {
  try {
    observability.warn(message, {
      ...safeSnapshotError(error, "worker-lifecycle"),
      ...(lease.workspaceId
        ? { sandboxLeaseKey: sandboxLeaseTelemetryKey(lease.workspaceId, lease.sandboxGroupId) }
        : {}),
      leaseEpoch: lease.leaseEpoch,
    });
  } catch {
    // Logging cannot replace the provider failure or prevent claim release.
  }
}
