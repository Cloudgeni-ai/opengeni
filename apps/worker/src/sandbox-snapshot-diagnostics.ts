import {
  sandboxLeaseTelemetryKey,
  type Observability,
  type SnapshotArchiveReason,
} from "@opengeni/observability";

type SafeSnapshotError = {
  errorClass: "SnapshotOperationError";
  errorCode: "snapshot_operation_failed";
  status?: number;
  origin: "sandbox-resume" | "worker-lifecycle";
  causeName?: string;
  integrityCode?: string;
  archiveReason?: SnapshotArchiveReason;
  archiveExitCode?: number;
  providerErrorName?: string;
  providerGrpcCode?: number;
  providerHttpStatus?: number;
  providerRetryable?: boolean;
};

/** The archive check's fixed reasons (`workspace-tar-stream.ts`, as the
 * Agents SDK's) as a closed class. Reasons that end in a member path are
 * matched by their fixed prefix; the path itself is never logged. */
const ARCHIVE_REASON_PREFIXES: ReadonlyArray<readonly [string, SnapshotArchiveReason]> = [
  ["hardlink member not allowed", "hardlink_member"],
  ["archive root hardlink", "hardlink_member"],
  ["symlink member not allowed", "symlink_member"],
  ["archive root symlink", "symlink_member"],
  ["unsupported member type", "unsupported_member_type"],
  ["archive root member must be directory", "unsupported_member_type"],
  ["absolute path", "unsafe_member_path"],
  ["windows drive path", "unsafe_member_path"],
  ["windows path separator", "unsafe_member_path"],
  ["parent traversal", "unsafe_member_path"],
  ["duplicate archive path", "duplicate_member"],
  ["archive path descends through non-directory", "descends_through_non_directory"],
  ["archive member overlaps protected path", "protected_path_overlap"],
  ["archive directory blocks protected path", "protected_path_overlap"],
  ["archive member count exceeds limit", "member_count_limit"],
  ["archive extracted size exceeds limit", "extracted_size_limit"],
  ["archive input size exceeds limit", "input_size_limit"],
  ["truncated header", "truncated_archive"],
  ["truncated member payload", "truncated_archive"],
  ["invalid PAX", "invalid_tar_header"],
  ["PAX ", "invalid_tar_header"],
  ["global PAX", "invalid_tar_header"],
  ["NUL byte in PAX", "invalid_tar_header"],
  ["base-256 tar sizes", "invalid_tar_header"],
  ["invalid octal size", "invalid_tar_header"],
];

function archiveReason(details: unknown, read: (value: unknown, key: string) => unknown) {
  const reason = read(details, "reason");
  if (typeof reason === "string") {
    for (const [prefix, value] of ARCHIVE_REASON_PREFIXES) {
      if (reason.startsWith(prefix)) return value;
    }
    return "other_archive_check" as const;
  }
  // A provider's tar in the box exited non-zero (no member was refused).
  const exitCode = read(details, "exitCode");
  if (typeof exitCode === "number") return "tar_exit_nonzero" as const;
  return undefined;
}

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
  if (fields.causeName === "SandboxArchiveError") {
    const reason = archiveReason(details, read);
    if (reason) fields.archiveReason = reason;
    const exitCode = read(details, "exitCode");
    if (
      typeof exitCode === "number" &&
      Number.isInteger(exitCode) &&
      exitCode >= 0 &&
      exitCode <= 255
    )
      fields.archiveExitCode = exitCode;
  }
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
