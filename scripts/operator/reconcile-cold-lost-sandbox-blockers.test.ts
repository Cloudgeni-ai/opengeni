import { describe, expect, test } from "bun:test";
import type { ColdLostReconciliationPreview } from "@opengeni/db";
import {
  main,
  previewInputFromEnv,
  providerObjectObservationFromEnv,
  reconciliationMode,
  type ColdLostReconciliationDependencies,
} from "./reconcile-cold-lost-sandbox-blockers";

const locator = {
  OPENGENI_RECOVERY_ACCOUNT_ID: "account-1",
  OPENGENI_RECOVERY_WORKSPACE_ID: "workspace-1",
  OPENGENI_RECOVERY_SESSION_ID: "session-1",
  OPENGENI_RECOVERY_SANDBOX_GROUP_ID: "group-1",
};
const archiveReferenceSha256 = "b".repeat(64);
const treeFingerprintSha256 = "c".repeat(64);
const archiveRevision = `wa1:1785326400000:${archiveReferenceSha256}`;

describe("cold lost-provider reconciliation CLI", () => {
  test("authorizes only explicit preview or apply modes", () => {
    expect(reconciliationMode({ OPENGENI_COLD_LOST_LEASE_RECONCILE: "preview" })).toBe("preview");
    expect(reconciliationMode({ OPENGENI_COLD_LOST_LEASE_RECONCILE: "apply" })).toBe("apply");
    expect(() => reconciliationMode({})).toThrow("=preview");
    expect(() => reconciliationMode({ OPENGENI_COLD_LOST_LEASE_RECONCILE: "dry-run" })).toThrow(
      "=preview",
    );
  });

  test("preview preserves missing critical fences for typed DB blockers", () => {
    expect(previewInputFromEnv(locator)).toEqual({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sandboxGroupId: "group-1",
      providerObject: {
        providerBackend: null,
        objectKind: null,
        objectId: null,
        status: "unknown",
        observedAt: null,
      },
    });
  });

  test("parses the exact tuple, nullable fences, and provider observation", () => {
    const input = previewInputFromEnv({
      ...locator,
      OPENGENI_RECOVERY_LEASE_ID: "lease-1",
      OPENGENI_RECOVERY_BACKEND: "modal",
      OPENGENI_RECOVERY_CURRENT_EPOCH: "31",
      OPENGENI_RECOVERY_LOST_EPOCH: "30",
      OPENGENI_RECOVERY_LOST_INSTANCE_ID: "sb-lost",
      OPENGENI_RECOVERY_REFCOUNT: "2",
      OPENGENI_RECOVERY_PROVIDER_BACKEND: "modal",
      OPENGENI_RECOVERY_ROUTE_KIND: "home",
      OPENGENI_RECOVERY_ROUTE_TARGET_ID: "null",
      OPENGENI_RECOVERY_ROUTE_EPOCH: "0",
      OPENGENI_RECOVERY_WORKSPACE_GENERATION: "9",
      OPENGENI_RECOVERY_WORKSPACE_STATUS: "ready",
      OPENGENI_RECOVERY_RESTORE_STATUS: "ready",
      OPENGENI_RECOVERY_RESTORE_FAILURE_CODE: "null",
      OPENGENI_RECOVERY_ARCHIVE_GENERATION: "9",
      OPENGENI_RECOVERY_ARCHIVE_COMPLETE: "true",
      OPENGENI_RECOVERY_ARCHIVE_DESCRIPTOR_VERSION: "1",
      OPENGENI_RECOVERY_ARCHIVE_REVISION: archiveRevision,
      OPENGENI_RECOVERY_ARCHIVE_OBJECT_KIND: "modal_filesystem_snapshot",
      OPENGENI_RECOVERY_ARCHIVE_OBJECT_ID: "im-archive",
      OPENGENI_RECOVERY_ARCHIVE_DESCRIPTOR_REFERENCE_BYTES: "252885",
      OPENGENI_RECOVERY_ARCHIVE_DESCRIPTOR_REFERENCE_SHA256: archiveReferenceSha256,
      OPENGENI_RECOVERY_ARCHIVE_REFERENCE_BYTES: "252885",
      OPENGENI_RECOVERY_ARCHIVE_REFERENCE_SHA256: archiveReferenceSha256,
      OPENGENI_RECOVERY_ARCHIVE_TREE_FINGERPRINT_ALGORITHM: "sha256",
      OPENGENI_RECOVERY_ARCHIVE_TREE_FINGERPRINT_SHA256: treeFingerprintSha256,
      OPENGENI_RECOVERY_ARCHIVE_TREE_ENTRY_COUNT: "16",
      OPENGENI_RECOVERY_ARCHIVE_TREE_FILE_COUNT: "14",
      OPENGENI_RECOVERY_ARCHIVE_TOTAL_FILE_BYTES: "250000",
      OPENGENI_RECOVERY_ARCHIVE_CAPTURED_AT: "2026-07-29T11:58:00.000Z",
      OPENGENI_RECOVERY_ARCHIVE_VERIFICATION_STATE: "verified",
      OPENGENI_RECOVERY_ARCHIVE_VERIFIED_REVISION: archiveRevision,
      OPENGENI_RECOVERY_ARCHIVE_VERIFIED_AT: "2026-07-29T11:59:00.000Z",
      OPENGENI_RECOVERY_PROVIDER_OBJECT_KIND: "modal_filesystem_snapshot",
      OPENGENI_RECOVERY_PROVIDER_OBJECT_ID: "im-archive",
      OPENGENI_RECOVERY_PROVIDER_OBJECT_STATUS: "exists",
      OPENGENI_RECOVERY_PROVIDER_OBJECT_OBSERVED_AT: "2026-07-29T12:00:00.000Z",
    });
    expect(input).toEqual({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sandboxGroupId: "group-1",
      expectedLeaseId: "lease-1",
      expectedBackend: "modal",
      expectedCurrentEpoch: 31,
      expectedLostEpoch: 30,
      expectedLostInstanceId: "sb-lost",
      expectedRefcount: 2,
      expectedProviderBackend: "modal",
      expectedRouteKind: "home",
      expectedRouteTargetId: null,
      expectedRouteEpoch: 0,
      expectedWorkspaceGeneration: 9,
      expectedWorkspaceStatus: "ready",
      expectedRestoreStatus: "ready",
      expectedRestoreFailureCode: null,
      expectedArchiveGeneration: 9,
      expectedArchiveComplete: true,
      expectedArchiveDescriptorVersion: 1,
      expectedArchiveRevision: archiveRevision,
      expectedArchiveObjectKind: "modal_filesystem_snapshot",
      expectedArchiveObjectId: "im-archive",
      expectedDescriptorReferenceBytes: 252885,
      expectedDescriptorReferenceSha256: archiveReferenceSha256,
      expectedReferenceBytes: 252885,
      expectedReferenceSha256: archiveReferenceSha256,
      expectedTreeFingerprintAlgorithm: "sha256",
      expectedTreeFingerprintSha256: treeFingerprintSha256,
      expectedTreeEntryCount: 16,
      expectedTreeFileCount: 14,
      expectedTotalFileBytes: 250000,
      expectedArchiveCapturedAt: "2026-07-29T11:58:00.000Z",
      expectedArchiveVerificationState: "verified",
      expectedArchiveVerifiedRevision: archiveRevision,
      expectedArchiveVerifiedAt: "2026-07-29T11:59:00.000Z",
      providerObject: {
        providerBackend: "modal",
        objectKind: "modal_filesystem_snapshot",
        objectId: "im-archive",
        status: "exists",
        observedAt: "2026-07-29T12:00:00.000Z",
      },
    });
  });

  test("rejects ambiguous scalar, route, status, and object-kind values", () => {
    expect(() =>
      previewInputFromEnv({
        ...locator,
        OPENGENI_RECOVERY_CURRENT_EPOCH: "3.1",
      }),
    ).toThrow("nonnegative safe integer");
    expect(() =>
      previewInputFromEnv({
        ...locator,
        OPENGENI_RECOVERY_ARCHIVE_COMPLETE: "TRUE",
      }),
    ).toThrow("exactly true or false");
    expect(() =>
      previewInputFromEnv({
        ...locator,
        OPENGENI_RECOVERY_ROUTE_KIND: "default",
      }),
    ).toThrow("exactly home or active");
    expect(() =>
      providerObjectObservationFromEnv({
        OPENGENI_RECOVERY_PROVIDER_OBJECT_STATUS: "available",
      }),
    ).toThrow("exactly exists, missing, or unknown");
    expect(() =>
      providerObjectObservationFromEnv({
        OPENGENI_RECOVERY_PROVIDER_OBJECT_KIND: "modal_image",
      }),
    ).toThrow("modal_filesystem_snapshot");
    expect(() =>
      previewInputFromEnv({
        ...locator,
        OPENGENI_RECOVERY_ARCHIVE_DESCRIPTOR_VERSION: "2",
      }),
    ).toThrow("exactly 1");
    expect(() =>
      previewInputFromEnv({
        ...locator,
        OPENGENI_RECOVERY_ARCHIVE_TREE_FINGERPRINT_SHA256: "A".repeat(64),
      }),
    ).toThrow("64 lowercase hexadecimal");
    expect(() =>
      previewInputFromEnv({
        ...locator,
        OPENGENI_RECOVERY_ARCHIVE_CAPTURED_AT: "2026-07-29T12:00:00Z",
      }),
    ).toThrow("canonical ISO-8601 UTC");
    expect(() =>
      previewInputFromEnv({
        ...locator,
        OPENGENI_RECOVERY_ARCHIVE_TREE_FINGERPRINT_ALGORITHM: "sha-256",
      }),
    ).toThrow("exactly sha256");
    expect(() =>
      providerObjectObservationFromEnv({
        OPENGENI_RECOVERY_PROVIDER_OBJECT_OBSERVED_AT: "2026-07-29T12:00:00Z",
      }),
    ).toThrow("canonical ISO-8601 UTC");
  });

  test("preview wiring cannot invoke apply or a provider dependency", async () => {
    const calls: string[] = [];
    const output: string[] = [];
    let applyCalls = 0;
    const blockedPreview = {
      version: 1,
      status: "blocked",
      previewId: `clrp1:${"a".repeat(64)}`,
      blockers: ["expected_lease_id_missing"],
    } as ColdLostReconciliationPreview;
    const dependencies: ColdLostReconciliationDependencies = {
      openDatabase: () => {
        calls.push("open-database");
        return {
          db: null as never,
          close: async () => {
            calls.push("close-database");
          },
        };
      },
      preview: async (_db, input) => {
        calls.push("preview");
        expect(input.providerObject.status).toBe("unknown");
        return blockedPreview;
      },
      apply: async () => {
        applyCalls += 1;
        throw new Error("preview must not invoke apply");
      },
      output: (line) => {
        calls.push("output");
        output.push(line);
      },
    };

    const exitCode = await main(
      {
        ...locator,
        OPENGENI_COLD_LOST_LEASE_RECONCILE: "preview",
      },
      dependencies,
    );

    expect(exitCode).toBe(2);
    expect(applyCalls).toBe(0);
    expect(calls).toEqual(["open-database", "preview", "output", "close-database"]);
    expect(output).toHaveLength(1);
    expect(output[0]).toStartWith("OPENGENI_COLD_LOST_LEASE_RECONCILE_PREVIEW=");
    expect(Object.keys(dependencies).sort()).toEqual([
      "apply",
      "openDatabase",
      "output",
      "preview",
    ]);
  });
});
