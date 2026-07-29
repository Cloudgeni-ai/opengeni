import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  createDb,
  previewColdLostLeaseInstanceBlockers,
  reconcileColdLostLeaseInstanceBlockers,
  type ColdLostProviderObjectObservation,
  type Database,
  type PreviewColdLostLeaseInstanceBlockersInput,
  type SandboxRestoreStatus,
  type SandboxWorkspaceReadiness,
} from "@opengeni/db";

export type ColdLostReconciliationMode = "preview" | "apply";

export type ColdLostReconciliationDependencies = {
  openDatabase: () => {
    db: Database;
    close: () => Promise<void>;
  };
  preview: typeof previewColdLostLeaseInstanceBlockers;
  apply: typeof reconcileColdLostLeaseInstanceBlockers;
  output: (line: string) => void;
};

const defaultDependencies: ColdLostReconciliationDependencies = {
  openDatabase: () => {
    const settings = getSettings();
    const searchPath = dbSearchPath(settings);
    const client = createDb(settings.databaseUrl, {
      ...(searchPath ? { searchPath } : {}),
      rlsStrategy: settings.rlsStrategy,
      max: 1,
    });
    return { db: client.db, close: async () => await client.close() };
  },
  preview: previewColdLostLeaseInstanceBlockers,
  apply: reconcileColdLostLeaseInstanceBlockers,
  output: (line) => console.log(line),
};

export function reconciliationMode(
  env: NodeJS.ProcessEnv,
): ColdLostReconciliationMode {
  const value = env.OPENGENI_COLD_LOST_LEASE_RECONCILE?.trim();
  if (value === "preview" || value === "apply") return value;
  throw new Error(
    "Set OPENGENI_COLD_LOST_LEASE_RECONCILE=preview for a read-only snapshot or =apply for exact blocker settlement",
  );
}

export function previewInputFromEnv(
  env: NodeJS.ProcessEnv,
): PreviewColdLostLeaseInstanceBlockersInput {
  return {
    accountId: required(env, "OPENGENI_RECOVERY_ACCOUNT_ID"),
    workspaceId: required(env, "OPENGENI_RECOVERY_WORKSPACE_ID"),
    sessionId: required(env, "OPENGENI_RECOVERY_SESSION_ID"),
    sandboxGroupId: required(env, "OPENGENI_RECOVERY_SANDBOX_GROUP_ID"),
    ...optionalStringField(
      env,
      "OPENGENI_RECOVERY_LEASE_ID",
      "expectedLeaseId",
    ),
    ...optionalStringField(
      env,
      "OPENGENI_RECOVERY_BACKEND",
      "expectedBackend",
    ),
    ...optionalIntegerField(
      env,
      "OPENGENI_RECOVERY_CURRENT_EPOCH",
      "expectedCurrentEpoch",
    ),
    ...optionalIntegerField(
      env,
      "OPENGENI_RECOVERY_LOST_EPOCH",
      "expectedLostEpoch",
    ),
    ...optionalStringField(
      env,
      "OPENGENI_RECOVERY_LOST_INSTANCE_ID",
      "expectedLostInstanceId",
    ),
    ...optionalIntegerField(
      env,
      "OPENGENI_RECOVERY_REFCOUNT",
      "expectedRefcount",
    ),
    ...optionalStringField(
      env,
      "OPENGENI_RECOVERY_PROVIDER_BACKEND",
      "expectedProviderBackend",
    ),
    ...optionalRouteKindField(env),
    ...optionalNullableStringField(
      env,
      "OPENGENI_RECOVERY_ROUTE_TARGET_ID",
      "expectedRouteTargetId",
    ),
    ...optionalIntegerField(
      env,
      "OPENGENI_RECOVERY_ROUTE_EPOCH",
      "expectedRouteEpoch",
    ),
    ...optionalIntegerField(
      env,
      "OPENGENI_RECOVERY_WORKSPACE_GENERATION",
      "expectedWorkspaceGeneration",
    ),
    ...optionalWorkspaceStatusField(env),
    ...optionalRestoreStatusField(env),
    ...optionalNullableStringField(
      env,
      "OPENGENI_RECOVERY_RESTORE_FAILURE_CODE",
      "expectedRestoreFailureCode",
    ),
    ...optionalNullableIntegerField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_GENERATION",
      "expectedArchiveGeneration",
    ),
    ...optionalBooleanField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_COMPLETE",
      "expectedArchiveComplete",
    ),
    ...optionalArchiveDescriptorVersionField(env),
    ...optionalArchiveRevisionField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_REVISION",
      "expectedArchiveRevision",
    ),
    ...optionalArchiveObjectKindField(env),
    ...optionalStringField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_OBJECT_ID",
      "expectedArchiveObjectId",
    ),
    ...optionalPositiveIntegerField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_DESCRIPTOR_REFERENCE_BYTES",
      "expectedDescriptorReferenceBytes",
    ),
    ...optionalSha256Field(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_DESCRIPTOR_REFERENCE_SHA256",
      "expectedDescriptorReferenceSha256",
    ),
    ...optionalPositiveIntegerField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_REFERENCE_BYTES",
      "expectedReferenceBytes",
    ),
    ...optionalSha256Field(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_REFERENCE_SHA256",
      "expectedReferenceSha256",
    ),
    ...optionalTreeFingerprintAlgorithmField(env),
    ...optionalSha256Field(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_TREE_FINGERPRINT_SHA256",
      "expectedTreeFingerprintSha256",
    ),
    ...optionalIntegerField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_TREE_ENTRY_COUNT",
      "expectedTreeEntryCount",
    ),
    ...optionalIntegerField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_TREE_FILE_COUNT",
      "expectedTreeFileCount",
    ),
    ...optionalIntegerField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_TOTAL_FILE_BYTES",
      "expectedTotalFileBytes",
    ),
    ...optionalCanonicalIsoField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_CAPTURED_AT",
      "expectedArchiveCapturedAt",
    ),
    ...optionalArchiveVerificationStateField(env),
    ...optionalNullableArchiveRevisionField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_VERIFIED_REVISION",
      "expectedArchiveVerifiedRevision",
    ),
    ...optionalNullableCanonicalIsoField(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_VERIFIED_AT",
      "expectedArchiveVerifiedAt",
    ),
    providerObject: providerObjectObservationFromEnv(env),
  };
}

export function providerObjectObservationFromEnv(
  env: NodeJS.ProcessEnv,
): ColdLostProviderObjectObservation {
  const status =
    optional(env, "OPENGENI_RECOVERY_PROVIDER_OBJECT_STATUS") ?? "unknown";
  if (status !== "exists" && status !== "missing" && status !== "unknown") {
    throw new Error(
      "OPENGENI_RECOVERY_PROVIDER_OBJECT_STATUS must be exactly exists, missing, or unknown",
    );
  }
  const objectKind = optional(
    env,
    "OPENGENI_RECOVERY_PROVIDER_OBJECT_KIND",
  );
  if (
    objectKind !== undefined &&
    objectKind !== "modal_filesystem_snapshot" &&
    objectKind !== "modal_directory_snapshot"
  ) {
    throw new Error(
      "OPENGENI_RECOVERY_PROVIDER_OBJECT_KIND must be exactly modal_filesystem_snapshot or modal_directory_snapshot",
    );
  }
  const observedAt = optional(
    env,
    "OPENGENI_RECOVERY_PROVIDER_OBJECT_OBSERVED_AT",
  );
  return {
    providerBackend:
      optional(env, "OPENGENI_RECOVERY_PROVIDER_BACKEND") ?? null,
    objectKind: objectKind ?? null,
    objectId:
      optional(env, "OPENGENI_RECOVERY_PROVIDER_OBJECT_ID") ?? null,
    status,
    observedAt:
      observedAt === undefined
        ? null
        : canonicalIso(
            env,
            "OPENGENI_RECOVERY_PROVIDER_OBJECT_OBSERVED_AT",
          ),
  };
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ColdLostReconciliationDependencies = defaultDependencies,
): Promise<number> {
  const mode = reconciliationMode(env);
  const input = previewInputFromEnv(env);
  const client = dependencies.openDatabase();

  try {
    if (mode === "preview") {
      const preview = await dependencies.preview(client.db, input);
      dependencies.output(
        `OPENGENI_COLD_LOST_LEASE_RECONCILE_PREVIEW=${JSON.stringify(preview)}`,
      );
      return preview.status === "eligible" ? 0 : 2;
    }

    const exact = exactApplyInput(env, input);
    const result = await dependencies.apply(client.db, exact);
    const receipt =
      result.status === "reconciled"
        ? {
            status: result.status,
            previewId: exact.expectedPreviewId,
            leaseEpoch: result.lease.leaseEpoch,
            workspaceGeneration: result.lease.workspaceGeneration,
            archiveGeneration: result.lease.archiveGeneration,
            archiveComplete: result.lease.archiveComplete,
            recovery: {
              provider: result.lease.recovery.provider.status,
              restore: result.lease.recovery.restore.status,
              workspace: result.lease.recovery.workspace.status,
            },
            settlement: result.settlement,
          }
        : {
            status: result.status,
            expectedPreviewId: exact.expectedPreviewId,
            observedPreviewId: result.preview.previewId,
            preview: result.preview,
          };
    dependencies.output(
      `OPENGENI_COLD_LOST_LEASE_RECONCILE_RESULT=${JSON.stringify(receipt)}`,
    );
    return result.status === "reconciled" ? 0 : 2;
  } finally {
    await client.close();
  }
}

function exactApplyInput(
  env: NodeJS.ProcessEnv,
  input: PreviewColdLostLeaseInstanceBlockersInput,
): Parameters<typeof reconcileColdLostLeaseInstanceBlockers>[1] {
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sandboxGroupId: input.sandboxGroupId,
    expectedLeaseId: required(env, "OPENGENI_RECOVERY_LEASE_ID"),
    expectedBackend: required(env, "OPENGENI_RECOVERY_BACKEND"),
    expectedCurrentEpoch: nonnegativeInteger(
      env,
      "OPENGENI_RECOVERY_CURRENT_EPOCH",
    ),
    expectedLostEpoch: nonnegativeInteger(
      env,
      "OPENGENI_RECOVERY_LOST_EPOCH",
    ),
    expectedLostInstanceId: required(
      env,
      "OPENGENI_RECOVERY_LOST_INSTANCE_ID",
    ),
    expectedRefcount: nonnegativeInteger(env, "OPENGENI_RECOVERY_REFCOUNT"),
    expectedProviderBackend: required(
      env,
      "OPENGENI_RECOVERY_PROVIDER_BACKEND",
    ),
    expectedRouteKind: routeKind(env, "OPENGENI_RECOVERY_ROUTE_KIND"),
    expectedRouteTargetId: nullableString(
      env,
      "OPENGENI_RECOVERY_ROUTE_TARGET_ID",
    ),
    expectedRouteEpoch: nonnegativeInteger(
      env,
      "OPENGENI_RECOVERY_ROUTE_EPOCH",
    ),
    expectedWorkspaceGeneration: nonnegativeInteger(
      env,
      "OPENGENI_RECOVERY_WORKSPACE_GENERATION",
    ),
    expectedWorkspaceStatus: workspaceStatus(
      env,
      "OPENGENI_RECOVERY_WORKSPACE_STATUS",
    ),
    expectedRestoreStatus: restoreStatus(
      env,
      "OPENGENI_RECOVERY_RESTORE_STATUS",
    ),
    expectedRestoreFailureCode: nullableString(
      env,
      "OPENGENI_RECOVERY_RESTORE_FAILURE_CODE",
    ),
    expectedArchiveGeneration: nullableNonnegativeInteger(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_GENERATION",
    ),
    expectedArchiveComplete: exactBoolean(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_COMPLETE",
    ),
    expectedArchiveDescriptorVersion: archiveDescriptorVersion(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_DESCRIPTOR_VERSION",
    ),
    expectedArchiveRevision: archiveRevision(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_REVISION",
    ),
    expectedArchiveObjectKind: archiveObjectKind(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_OBJECT_KIND",
    ),
    expectedArchiveObjectId: required(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_OBJECT_ID",
    ),
    expectedDescriptorReferenceBytes: positiveInteger(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_DESCRIPTOR_REFERENCE_BYTES",
    ),
    expectedDescriptorReferenceSha256: sha256(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_DESCRIPTOR_REFERENCE_SHA256",
    ),
    expectedReferenceBytes: positiveInteger(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_REFERENCE_BYTES",
    ),
    expectedReferenceSha256: sha256(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_REFERENCE_SHA256",
    ),
    expectedTreeFingerprintAlgorithm: treeFingerprintAlgorithm(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_TREE_FINGERPRINT_ALGORITHM",
    ),
    expectedTreeFingerprintSha256: sha256(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_TREE_FINGERPRINT_SHA256",
    ),
    expectedTreeEntryCount: nonnegativeInteger(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_TREE_ENTRY_COUNT",
    ),
    expectedTreeFileCount: nonnegativeInteger(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_TREE_FILE_COUNT",
    ),
    expectedTotalFileBytes: nonnegativeInteger(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_TOTAL_FILE_BYTES",
    ),
    expectedArchiveCapturedAt: canonicalIso(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_CAPTURED_AT",
    ),
    expectedArchiveVerificationState: archiveVerificationState(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_VERIFICATION_STATE",
    ),
    expectedArchiveVerifiedRevision: nullableArchiveRevision(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_VERIFIED_REVISION",
    ),
    expectedArchiveVerifiedAt: nullableCanonicalIso(
      env,
      "OPENGENI_RECOVERY_ARCHIVE_VERIFIED_AT",
    ),
    providerObject: input.providerObject,
    expectedPreviewId: required(env, "OPENGENI_RECOVERY_PREVIEW_ID"),
  };
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = optional(env, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function nonnegativeInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = nonnegativeInteger(env, name);
  if (value === 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function archiveDescriptorVersion(
  env: NodeJS.ProcessEnv,
  name: string,
): 1 {
  if (required(env, name) !== "1") {
    throw new Error(`${name} must be exactly 1`);
  }
  return 1;
}

function archiveRevision(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!/^wa1:[0-9]{13}:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a canonical wa1 archive revision`);
  }
  return value;
}

function nullableArchiveRevision(
  env: NodeJS.ProcessEnv,
  name: string,
): string | null {
  return required(env, name) === "null" ? null : archiveRevision(env, name);
}

function sha256(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be exactly 64 lowercase hexadecimal characters`);
  }
  return value;
}

function canonicalIso(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO-8601 UTC timestamp`);
  }
  return value;
}

function nullableCanonicalIso(
  env: NodeJS.ProcessEnv,
  name: string,
): string | null {
  return required(env, name) === "null" ? null : canonicalIso(env, name);
}

function archiveObjectKind(
  env: NodeJS.ProcessEnv,
  name: string,
): "modal_filesystem_snapshot" | "modal_directory_snapshot" {
  const value = required(env, name);
  if (
    value === "modal_filesystem_snapshot" ||
    value === "modal_directory_snapshot"
  ) {
    return value;
  }
  throw new Error(
    `${name} must be exactly modal_filesystem_snapshot or modal_directory_snapshot`,
  );
}

function treeFingerprintAlgorithm(
  env: NodeJS.ProcessEnv,
  name: string,
): "sha256" {
  if (required(env, name) !== "sha256") {
    throw new Error(`${name} must be exactly sha256`);
  }
  return "sha256";
}

function archiveVerificationState(
  env: NodeJS.ProcessEnv,
  name: string,
): "verified" | "unverified" {
  const value = required(env, name);
  if (value === "verified" || value === "unverified") return value;
  throw new Error(`${name} must be exactly verified or unverified`);
}

function nullableNonnegativeInteger(
  env: NodeJS.ProcessEnv,
  name: string,
): number | null {
  const value = required(env, name);
  return value === "null" ? null : nonnegativeInteger(env, name);
}

function nullableString(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = required(env, name);
  return value === "null" ? null : value;
}

function exactBoolean(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = required(env, name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly true or false`);
}

function routeKind(
  env: NodeJS.ProcessEnv,
  name: string,
): "home" | "active" {
  const value = required(env, name);
  if (value === "home" || value === "active") return value;
  throw new Error(`${name} must be exactly home or active`);
}

const WORKSPACE_STATUSES = [
  "unknown",
  "not_ready",
  "ready",
  "degraded",
  "unrecoverable",
] as const satisfies readonly SandboxWorkspaceReadiness[];

function workspaceStatus(
  env: NodeJS.ProcessEnv,
  name: string,
): SandboxWorkspaceReadiness {
  const value = required(env, name);
  if (WORKSPACE_STATUSES.some((status) => status === value)) {
    return value as SandboxWorkspaceReadiness;
  }
  throw new Error(`${name} has an unsupported workspace status`);
}

const RESTORE_STATUSES = [
  "not_required",
  "pending",
  "restoring",
  "verifying",
  "ready",
  "degraded",
  "unrecoverable",
] as const satisfies readonly SandboxRestoreStatus[];

function restoreStatus(
  env: NodeJS.ProcessEnv,
  name: string,
): SandboxRestoreStatus {
  const value = required(env, name);
  if (RESTORE_STATUSES.some((status) => status === value)) {
    return value as SandboxRestoreStatus;
  }
  throw new Error(`${name} has an unsupported restore status`);
}

function optionalStringField<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: string } {
  const value = optional(env, name);
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: string });
}

function optionalNullableStringField<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: string | null } {
  return optional(env, name) === undefined
    ? {}
    : ({ [key]: nullableString(env, name) } as {
        [P in K]: string | null;
      });
}

function optionalIntegerField<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: number } {
  return optional(env, name) === undefined
    ? {}
    : ({ [key]: nonnegativeInteger(env, name) } as { [P in K]: number });
}

function optionalPositiveIntegerField<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: number } {
  return optional(env, name) === undefined
    ? {}
    : ({ [key]: positiveInteger(env, name) } as { [P in K]: number });
}

function optionalSha256Field<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: string } {
  return optional(env, name) === undefined
    ? {}
    : ({ [key]: sha256(env, name) } as { [P in K]: string });
}

function optionalCanonicalIsoField<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: string } {
  return optional(env, name) === undefined
    ? {}
    : ({ [key]: canonicalIso(env, name) } as { [P in K]: string });
}

function optionalNullableCanonicalIsoField<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: string | null } {
  return optional(env, name) === undefined
    ? {}
    : ({ [key]: nullableCanonicalIso(env, name) } as {
        [P in K]: string | null;
      });
}

function optionalArchiveRevisionField<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: string } {
  return optional(env, name) === undefined
    ? {}
    : ({ [key]: archiveRevision(env, name) } as { [P in K]: string });
}

function optionalNullableArchiveRevisionField<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: string | null } {
  return optional(env, name) === undefined
    ? {}
    : ({ [key]: nullableArchiveRevision(env, name) } as {
        [P in K]: string | null;
      });
}

function optionalArchiveDescriptorVersionField(
  env: NodeJS.ProcessEnv,
): { expectedArchiveDescriptorVersion?: 1 } {
  const name = "OPENGENI_RECOVERY_ARCHIVE_DESCRIPTOR_VERSION";
  return optional(env, name) === undefined
    ? {}
    : { expectedArchiveDescriptorVersion: archiveDescriptorVersion(env, name) };
}

function optionalArchiveObjectKindField(
  env: NodeJS.ProcessEnv,
): {
  expectedArchiveObjectKind?:
    | "modal_filesystem_snapshot"
    | "modal_directory_snapshot";
} {
  const name = "OPENGENI_RECOVERY_ARCHIVE_OBJECT_KIND";
  return optional(env, name) === undefined
    ? {}
    : { expectedArchiveObjectKind: archiveObjectKind(env, name) };
}

function optionalTreeFingerprintAlgorithmField(
  env: NodeJS.ProcessEnv,
): { expectedTreeFingerprintAlgorithm?: "sha256" } {
  const name = "OPENGENI_RECOVERY_ARCHIVE_TREE_FINGERPRINT_ALGORITHM";
  return optional(env, name) === undefined
    ? {}
    : {
        expectedTreeFingerprintAlgorithm: treeFingerprintAlgorithm(env, name),
      };
}

function optionalArchiveVerificationStateField(
  env: NodeJS.ProcessEnv,
): { expectedArchiveVerificationState?: "verified" | "unverified" } {
  const name = "OPENGENI_RECOVERY_ARCHIVE_VERIFICATION_STATE";
  return optional(env, name) === undefined
    ? {}
    : {
        expectedArchiveVerificationState: archiveVerificationState(env, name),
      };
}

function optionalNullableIntegerField<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: number | null } {
  return optional(env, name) === undefined
    ? {}
    : ({ [key]: nullableNonnegativeInteger(env, name) } as {
        [P in K]: number | null;
      });
}

function optionalBooleanField<K extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: K,
): { [P in K]?: boolean } {
  return optional(env, name) === undefined
    ? {}
    : ({ [key]: exactBoolean(env, name) } as { [P in K]: boolean });
}

function optionalRouteKindField(
  env: NodeJS.ProcessEnv,
): { expectedRouteKind?: "home" | "active" } {
  const name = "OPENGENI_RECOVERY_ROUTE_KIND";
  return optional(env, name) === undefined
    ? {}
    : { expectedRouteKind: routeKind(env, name) };
}

function optionalWorkspaceStatusField(
  env: NodeJS.ProcessEnv,
): { expectedWorkspaceStatus?: SandboxWorkspaceReadiness } {
  const name = "OPENGENI_RECOVERY_WORKSPACE_STATUS";
  return optional(env, name) === undefined
    ? {}
    : { expectedWorkspaceStatus: workspaceStatus(env, name) };
}

function optionalRestoreStatusField(
  env: NodeJS.ProcessEnv,
): { expectedRestoreStatus?: SandboxRestoreStatus } {
  const name = "OPENGENI_RECOVERY_RESTORE_STATUS";
  return optional(env, name) === undefined
    ? {}
    : { expectedRestoreStatus: restoreStatus(env, name) };
}

if (import.meta.main) {
  process.exitCode = await main();
}
