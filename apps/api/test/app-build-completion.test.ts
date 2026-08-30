import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { AppBuildManifest } from "@opengeni/contracts/apps";
import type { AppBuildStoragePlan } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { HTTPException } from "hono/http-exception";

import {
  createDatabaseAppsApplication,
  preflightAppBuildCompletion,
  verifiedAppBuildManifestBytes,
} from "../src/apps-application";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const appId = "33333333-3333-4333-8333-333333333333";
const buildId = "44444444-4444-4444-8444-444444444444";
const fileId = "55555555-5555-4555-8555-555555555555";
const sourceRevisionId = "66666666-6666-4666-8666-666666666666";
const toolPolicyRevisionId = "77777777-7777-4777-8777-777777777777";
const digest = "a".repeat(64);

const manifest: AppBuildManifest = {
  version: "opengeni.app-build.v1",
  entryPath: "index.html",
  totalBytes: 5,
  files: [
    {
      path: "index.html",
      contentType: "text/html; charset=utf-8",
      contentSha256: digest,
      sizeBytes: 5,
      executable: false,
    },
  ],
};

const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");

function completionPlan(
  status: AppBuildStoragePlan["build"]["status"],
  options: Readonly<{
    expectedDigest?: string;
    frozenVersionToken?: string | null;
    manifestVersionToken?: string | null;
    receiptDigest?: string | null;
  }> = {},
): Pick<AppBuildStoragePlan, "build" | "files" | "manifestVersionToken"> {
  return {
    build: {
      id: buildId,
      accountId,
      workspaceId,
      appId,
      sourceRevisionId,
      toolPolicyRevisionId,
      revision: 1,
      status,
      manifestSha256: options.expectedDigest ?? manifestSha256,
      entryPath: manifest.entryPath,
      fileCount: 1,
      totalBytes: manifest.totalBytes,
      checks: [],
      receiptDigest: options.receiptDigest ?? null,
      failureCode: null,
      createdBySubjectId: "human:app-build-test",
      createdAt: "2026-08-30T00:00:00.000Z",
      verifiedAt: status === "succeeded" ? "2026-08-30T00:01:00.000Z" : null,
    },
    manifestVersionToken: options.manifestVersionToken ?? null,
    files: [
      {
        id: fileId,
        path: manifest.files[0]!.path,
        contentType: manifest.files[0]!.contentType,
        contentSha256: manifest.files[0]!.contentSha256,
        sizeBytes: manifest.files[0]!.sizeBytes,
        executable: false,
        stagingObjectKey: "apps/staging/index.html",
        frozenObjectKey: "apps/frozen/index.html",
        frozenVersionToken: options.frozenVersionToken ?? null,
      },
    ],
  };
}

describe("App build manifest admission", () => {
  test("rejects a digest mismatch before storage or persistence is consulted", async () => {
    const application = createDatabaseAppsApplication({
      db: {} as never,
      storage: null,
      settings: testSettings(),
    });

    try {
      await application.prepareBuild({
        authority: {
          accountId,
          workspaceId,
          subjectId: "human:app-build-test",
          principalKind: "human_session",
          canonicalManagedHumanSession: true,
          canonicalLocalHumanSession: false,
          permissions: ["apps:write"],
          sourceSessionId: null,
          sourceTurnId: null,
          sourceAttemptId: null,
          sourceExecutionGeneration: null,
        },
        appId,
        request: {
          sourceRevisionId,
          toolPolicyRevisionId,
          manifestSha256: "b".repeat(64),
          manifest,
          checks: ["typecheck", "test", "build"].map((kind) => ({
            kind: kind as "typecheck" | "test" | "build",
            status: "succeeded" as const,
            commandDigest: "c".repeat(64),
            outputDigest: "d".repeat(64),
            durationMs: 1,
          })),
          expectedAppVersion: 1,
          idempotencyKey: "prepare-build-digest-mismatch",
        },
      });
      throw new Error("expected App build manifest rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPException);
      expect((error as HTTPException).status).toBe(422);
      expect((error as Error).message).toBe("App build manifest digest does not match");
    }
  });

  test("returns the exact bytes whose digest was admitted", () => {
    const bytes = verifiedAppBuildManifestBytes(manifest, manifestSha256);
    expect(Buffer.from(bytes).toString("utf8")).toBe(JSON.stringify(manifest));
  });
});

describe("App build completion preflight", () => {
  test("rejects manifest identity drift before immutable object work", () => {
    expectHttpFailure(
      () => preflightAppBuildCompletion(completionPlan("uploading"), "b".repeat(64)),
      409,
      "App build manifest changed",
    );
  });

  test("rejects failed and deleting builds before immutable object work", () => {
    for (const status of ["failed", "deleting", "deleted"] as const) {
      expectHttpFailure(
        () => preflightAppBuildCompletion(completionPlan(status), manifestSha256),
        422,
        "App build is already settled",
      );
    }
  });

  test("reconstructs exact stored receipts for a cheap successful replay", () => {
    expect(
      preflightAppBuildCompletion(
        completionPlan("succeeded", {
          frozenVersionToken: "file-version-1",
          manifestVersionToken: "manifest-version-1",
          receiptDigest: digest,
        }),
        manifestSha256,
      ),
    ).toEqual({
      kind: "replay",
      frozenFiles: [{ fileId, frozenVersionToken: "file-version-1" }],
      manifestVersionToken: "manifest-version-1",
      receiptDigest: digest,
    });
  });

  test("allows only unsettled builds to enter immutable verification", () => {
    for (const status of ["queued", "running", "uploading", "verifying"] as const) {
      expect(preflightAppBuildCompletion(completionPlan(status), manifestSha256)).toEqual({
        kind: "verify",
      });
    }
  });
});

function expectHttpFailure(operation: () => unknown, status: number, message: string): void {
  try {
    operation();
    throw new Error("expected HTTP failure");
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPException);
    expect((error as HTTPException).status).toBe(status);
    expect((error as Error).message).toBe(message);
  }
}
