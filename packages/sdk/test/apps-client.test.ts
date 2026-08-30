import { describe, expect, test } from "bun:test";

import {
  OpenGeniAppsClient,
  type OpenGeniAppsControlOperation,
  type OpenGeniAppsControlOperationMap,
  type OpenGeniAppsControlTransport,
} from "../src/apps";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const RELEASE_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const LAUNCH_ID = "77777777-7777-4777-8777-777777777777";
const SOURCE_ID = "88888888-8888-4888-8888-888888888888";
const BUILD_ID = "99999999-9999-4999-8999-999999999999";
const PREVIEW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDEMPOTENCY_KEY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHA256 = "a".repeat(64);
const APP = {
  id: APP_ID,
  accountId: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  slug: "status-console",
  title: "Status console",
  description: null,
  status: "active" as const,
  version: 1,
  latestSourceRevisionId: null,
  latestBuildId: null,
  activeReleaseId: null,
  createdBySubjectId: "subject-1",
  createdAt: "2026-08-29T12:00:00.000Z",
  updatedAt: "2026-08-29T12:00:00.000Z",
};
const DETAIL = {
  app: APP,
  sourceRevisions: [],
  builds: [],
  releases: [],
  previews: [],
  toolPolicies: [],
  historyTruncated: false,
};
const SOURCE_REVISION = {
  id: SOURCE_ID,
  accountId: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  appId: APP_ID,
  revision: 1,
  format: "portable_tar_v1" as const,
  status: "uploading" as const,
  contentSha256: SHA256,
  sizeBytes: 1,
  fileCount: null,
  failureCode: null,
  sourceSessionId: null,
  sourceTurnId: null,
  sourceAttemptId: null,
  sourceExecutionGeneration: null,
  createdBySubjectId: "subject-1",
  createdAt: "2026-08-29T12:00:00.000Z",
  verifiedAt: null,
};
const BUILD = {
  id: BUILD_ID,
  accountId: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  appId: APP_ID,
  sourceRevisionId: SOURCE_ID,
  toolPolicyRevisionId: POLICY_ID,
  revision: 1,
  status: "uploading" as const,
  manifestSha256: SHA256,
  entryPath: "index.html",
  fileCount: 1,
  totalBytes: 1,
  checks: [],
  receiptDigest: null,
  failureCode: null,
  createdBySubjectId: "subject-1",
  createdAt: "2026-08-29T12:00:00.000Z",
  verifiedAt: null,
};
const RELEASE = {
  id: RELEASE_ID,
  accountId: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  appId: APP_ID,
  buildId: BUILD_ID,
  sourceRevisionId: SOURCE_ID,
  toolPolicyRevisionId: POLICY_ID,
  revision: 1,
  status: "ready" as const,
  manifestSha256: SHA256,
  entryPath: "index.html",
  fileCount: 1,
  totalBytes: 1,
  buildReceiptDigest: SHA256,
  createdBySubjectId: "subject-1",
  createdAt: "2026-08-29T12:00:00.000Z",
};
const PREVIEW = {
  id: PREVIEW_ID,
  accountId: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  appId: APP_ID,
  releaseId: RELEASE_ID,
  status: "active" as const,
  createdBySubjectId: "subject-1",
  createdAt: "2026-08-29T12:00:00.000Z",
  expiresAt: "2026-08-29T18:00:00.000Z",
  revokedAt: null,
};
const SIGNED_UPLOAD = {
  url: "https://storage.example.test/upload",
  method: "PUT" as const,
  headers: { "content-type": "application/octet-stream" },
  expiresAt: "2026-08-29T18:00:00.000Z",
};

describe("OpenGeni Apps SDK client", () => {
  test("keeps every Apps operation behind the injected control transport", async () => {
    const requests: Array<{ operation: OpenGeniAppsControlOperation; input: unknown }> = [];
    const transport: OpenGeniAppsControlTransport = {
      async request(operation, input) {
        requests.push({ operation, input });
        const outputs: {
          [K in OpenGeniAppsControlOperation]: OpenGeniAppsControlOperationMap[K]["output"];
        } = {
          "apps.list": { apps: [], nextCursor: null, truncated: false },
          "apps.get": DETAIL,
          "apps.create": { app: APP, replayed: false },
          "apps.update": { app: APP, replayed: false },
          "apps.toolPolicy.create": DETAIL,
          "apps.source.begin": {
            sourceRevision: SOURCE_REVISION,
            stagingUpload: SIGNED_UPLOAD,
            replayed: false,
          },
          "apps.source.complete": DETAIL,
          "apps.source.download": {
            sourceRevision: SOURCE_REVISION,
            url: "https://api.example.test/download",
            expiresAt: "2026-08-29T18:00:00.000Z",
          },
          "apps.build.prepare": {
            build: BUILD,
            uploads: [{ path: "index.html", stagingUpload: SIGNED_UPLOAD }],
            nextCursor: null,
            replayed: false,
          },
          "apps.build.uploads.list": {
            buildId: BUILD_ID,
            uploads: [{ path: "index.html", stagingUpload: SIGNED_UPLOAD }],
            nextCursor: null,
          },
          "apps.build.complete": { app: APP, build: BUILD, replayed: false },
          "apps.release.promote": { app: APP, release: RELEASE, replayed: false },
          "apps.preview.create": {
            preview: PREVIEW,
            url: "https://console.example.test/apps/preview",
            replayed: false,
          },
          "apps.publish": { app: APP, release: RELEASE, replayed: false },
          "apps.rollback": { app: APP, release: RELEASE, replayed: false },
          "apps.unpublish": { app: APP, replayed: false },
          "apps.archive": { app: APP, replayed: false },
          "apps.runtime.catalog": {
            appId: APP_ID,
            releaseId: RELEASE_ID,
            toolPolicyRevisionId: POLICY_ID,
            catalogDigest: SHA256,
            tools: [],
          },
          "apps.runtime.availableCatalog": {
            appId: APP_ID,
            catalogDigest: SHA256,
            tools: [],
          },
          "apps.launch.create": {
            launchId: LAUNCH_ID,
            appId: APP_ID,
            releaseId: RELEASE_ID,
            authorityGeneration: "actor:7",
            launchUrl: "https://apps.example.test/run/1",
            appOrigin: "https://apps.example.test",
            nonce: "n".repeat(32),
            expiresAt: "2026-08-29T18:00:00.000Z",
          },
          "apps.runtime.tool.call": {
            operationId: OPERATION_ID,
            status: "succeeded",
            output: { ok: true },
            error: null,
            replayed: false,
          },
        };
        return outputs[operation] as never;
      },
    };
    const client = new OpenGeniAppsClient(transport);

    await client.listApps(" workspace-1 ", { limit: 20 });
    await client.getApp("workspace-1", "app-1");
    await client.createApp("workspace-1", {
      slug: "status-console",
      title: "Status console",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.updateApp("workspace-1", "app-1", {
      title: "Status console",
      expectedVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.createToolPolicy("workspace-1", "app-1", {
      allowedTools: [],
      catalogDigest: SHA256,
      expectedAppVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.beginSourceUpload("workspace-1", "app-1", {
      format: "portable_tar_v1",
      contentSha256: SHA256,
      sizeBytes: 1,
      expectedAppVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.completeSourceUpload("workspace-1", "app-1", SOURCE_ID, {
      expectedContentSha256: SHA256,
      expectedSizeBytes: 1,
      fileCount: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.getSourceDownload("workspace-1", "app-1", SOURCE_ID);
    await client.prepareBuild("workspace-1", "app-1", {
      sourceRevisionId: SOURCE_ID,
      toolPolicyRevisionId: POLICY_ID,
      manifestSha256: SHA256,
      manifest: {
        version: "opengeni.app-build.v1",
        entryPath: "index.html",
        files: [
          {
            path: "index.html",
            contentType: "text/html; charset=utf-8",
            contentSha256: SHA256,
            sizeBytes: 1,
            executable: false,
          },
        ],
        totalBytes: 1,
      },
      checks: (["typecheck", "test", "build"] as const).map((kind) => ({
        kind,
        status: "succeeded" as const,
        commandDigest: SHA256,
        outputDigest: SHA256,
        durationMs: 1,
      })),
      expectedAppVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.listBuildUploads("workspace-1", "app-1", BUILD_ID, { limit: 100 });
    await client.completeBuild("workspace-1", "app-1", BUILD_ID, {
      expectedManifestSha256: SHA256,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.promoteBuild("workspace-1", "app-1", {
      buildId: BUILD_ID,
      expectedAppVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.createPreview("workspace-1", "app-1", {
      releaseId: RELEASE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.publish("workspace-1", "app-1", {
      releaseId: RELEASE_ID,
      expectedAppVersion: 1,
      reason: "Publish tested app",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.rollback("workspace-1", "app-1", {
      releaseId: RELEASE_ID,
      expectedAppVersion: 1,
      reason: "Restore prior release",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.unpublish("workspace-1", "app-1", {
      expectedAppVersion: 1,
      reason: "Take app offline",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.archive("workspace-1", "app-1", {
      expectedAppVersion: 1,
      reason: "Archive retired app",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await client.getRuntimeCatalog("workspace-1", "app-1", RELEASE_ID);
    await client.getAvailableRuntimeCatalog("workspace-1", "app-1");
    await client.createLaunch("workspace-1", "app-1", { releaseId: RELEASE_ID });
    await client.callRuntimeTool(
      "workspace-1",
      "app-1",
      RELEASE_ID,
      LAUNCH_ID,
      "actor:7",
      "n".repeat(32),
      {
        operationId: OPERATION_ID,
        identity: { serverId: "status", toolName: "read" },
        input: {},
        catalogDigest: "a".repeat(64),
      },
    );

    expect(requests.map(({ operation }) => operation)).toEqual([
      "apps.list",
      "apps.get",
      "apps.create",
      "apps.update",
      "apps.toolPolicy.create",
      "apps.source.begin",
      "apps.source.complete",
      "apps.source.download",
      "apps.build.prepare",
      "apps.build.uploads.list",
      "apps.build.complete",
      "apps.release.promote",
      "apps.preview.create",
      "apps.publish",
      "apps.rollback",
      "apps.unpublish",
      "apps.archive",
      "apps.runtime.catalog",
      "apps.runtime.availableCatalog",
      "apps.launch.create",
      "apps.runtime.tool.call",
    ]);
    expect(requests[0]!.input).toEqual({ workspaceId: "workspace-1", query: { limit: 20 } });
    expect(requests.at(-1)!.input).toEqual({
      workspaceId: "workspace-1",
      appId: "app-1",
      releaseId: RELEASE_ID,
      launchId: LAUNCH_ID,
      authorityGeneration: "actor:7",
      launchNonce: "n".repeat(32),
      request: {
        operationId: OPERATION_ID,
        identity: { serverId: "status", toolName: "read" },
        input: {},
        catalogDigest: SHA256,
      },
    });
  });

  test("fails before transport dispatch for empty ids and weak launch nonces", async () => {
    let calls = 0;
    const client = new OpenGeniAppsClient({
      async request() {
        calls += 1;
        throw new Error("unreachable");
      },
    });
    await expect(client.getApp("workspace-1", " ")).rejects.toBeInstanceOf(TypeError);
    await expect(
      client.callRuntimeTool("workspace-1", "app-1", "release-1", LAUNCH_ID, "actor:7", "weak", {
        operationId: "11111111-1111-4111-8111-111111111111",
        identity: { serverId: "status", toolName: "read" },
        input: {},
        catalogDigest: "a".repeat(64),
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
  });
});
