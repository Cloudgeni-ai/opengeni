export type EditableArtifactOpenFailureCategory =
  | "unsupported_old_format"
  | "byte_corruption"
  | "authored_causal_mismatch"
  | "runtime_package_mismatch"
  | "projection_parity_ci_failure";

/** Content-free, bounded telemetry safe to emit for workbook-open failures. */
export type EditableArtifactOpenFailureEvent = Readonly<{
  category: EditableArtifactOpenFailureCategory;
  code: string;
}>;

export type EditableArtifactOpenFailureReporter = (event: EditableArtifactOpenFailureEvent) => void;

const BYTE_CORRUPTION_CODES = new Set([
  "byte_corruption",
  "artifact_bad_magic",
  "artifact_checksum_mismatch",
  "artifact_invalid_collaboration_snapshot",
  "artifact_invalid_snapshot",
  "artifact_invalid_tag",
  "artifact_invalid_utf8",
  "artifact_non_canonical",
  "artifact_trailing_bytes",
  "artifact_truncated",
]);
const AUTHORED_CAUSAL_CODES = new Set([
  "artifact_state_mismatch",
  "authored_causal_mismatch",
  "committed_metadata_mismatch",
  "invalid_frontier",
  "kernel_diverged",
]);
const RUNTIME_PACKAGE_CODES = new Set([
  "artifact_runtime_incompatible",
  "artifact_runtime_integrity",
  "artifact_runtime_manifest_invalid",
  "artifact_runtime_unavailable",
  "artifact_runtime_unsupported_target",
  "incompatible_wasm_build",
  "runtime_identity_mismatch",
]);

/** Maps only stable error codes; messages and workbook/formula content are ignored. */
export function classifyEditableArtifactOpenFailure(
  error: unknown,
): EditableArtifactOpenFailureEvent | null {
  const code = normalizedErrorCode(error);
  if (code === null) return null;
  let category: EditableArtifactOpenFailureCategory | null = null;
  if (code === "unsupported_protocol" || code === "artifact_unsupported_version") {
    category = "unsupported_old_format";
  } else if (BYTE_CORRUPTION_CODES.has(code)) {
    category = "byte_corruption";
  } else if (AUTHORED_CAUSAL_CODES.has(code)) {
    category = "authored_causal_mismatch";
  } else if (RUNTIME_PACKAGE_CODES.has(code)) {
    category = "runtime_package_mismatch";
  } else if (code === "artifact_runtime_projection_parity") {
    category = "projection_parity_ci_failure";
  }
  return category === null ? null : Object.freeze({ category, code });
}

function normalizedErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, "code");
  } catch {
    return null;
  }
  if (!descriptor || !("value" in descriptor)) return null;
  const value = descriptor.value;
  if (typeof value !== "string") return null;
  const code = value.toLowerCase();
  return /^[a-z][a-z0-9_]{0,127}$/u.test(code) ? code : null;
}
