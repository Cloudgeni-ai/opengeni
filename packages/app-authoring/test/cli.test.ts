import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AppBuild,
  AppBuildCheckReceipt,
  AppBuildManifest,
  AppPreview,
  AppRelease,
  AppSourceRevision,
  AppToolPolicyRevision,
  WorkspaceApp,
  WorkspaceAppDetailResponse,
} from "@opengeni/contracts/apps";
import {
  OpenGeniAppsClient,
  type OpenGeniAppsControlOperation,
  type OpenGeniAppsControlOperationMap,
  type OpenGeniAppsControlTransport,
} from "@opengeni/sdk/apps";

import { inspectPortableAppArchive } from "../src";
import { runOgAppCli, type OgAppCliIo } from "../src/cli";

const temporaryRoots: string[] = [];
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const APP_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_ID = "66666666-6666-4666-8666-666666666666";
const BUILD_ID = "77777777-7777-4777-8777-777777777777";
const RELEASE_ID = "88888888-8888-4888-8888-888888888888";
const PREVIEW_ID = "99999999-9999-4999-8999-999999999999";
const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);
const NOW = "2026-08-30T12:00:00.000Z";
const LATER = "2026-08-30T13:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

function io(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
): { io: OgAppCliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      env,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}

function checkReceipt(kind: AppBuildCheckReceipt["kind"]): AppBuildCheckReceipt {
  return {
    kind,
    status: "succeeded",
    commandDigest: SHA256_A,
    outputDigest: SHA256_B,
    durationMs: 1,
  };
}

function signedUpload(name: string) {
  return {
    url: `https://storage.example.test/${name}?token=must-not-persist`,
    method: "PUT" as const,
    headers: { "content-type": "application/octet-stream" },
    expiresAt: LATER,
  };
}

function deployFixture() {
  const calls: Array<{
    operation: OpenGeniAppsControlOperation;
    input: unknown;
  }> = [];
  let appVersion = 1;
  let latestSourceRevisionId: string | null = null;
  let latestBuildId: string | null = null;
  let activeReleaseId: string | null = null;
  let policy: AppToolPolicyRevision | null = null;
  let source: AppSourceRevision | null = null;
  let build: AppBuild | null = null;
  let release: AppRelease | null = null;
  let preview: AppPreview | null = null;
  let buildManifest: AppBuildManifest | null = null;

  const app = (): WorkspaceApp => ({
    id: APP_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    slug: "status-console",
    title: "Status console",
    description: null,
    status: "active",
    version: appVersion,
    latestSourceRevisionId,
    latestBuildId,
    activeReleaseId,
    createdBySubjectId: "subject-1",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const detail = (): WorkspaceAppDetailResponse => ({
    app: app(),
    sourceRevisions: source ? [source] : [],
    builds: build ? [build] : [],
    releases: release ? [release] : [],
    previews: preview ? [preview] : [],
    toolPolicies: policy ? [policy] : [],
    historyTruncated: false,
  });
  const transport: OpenGeniAppsControlTransport = {
    async request(operation, input) {
      calls.push({ operation, input });
      if (operation === "apps.list") {
        return { apps: [], nextCursor: null, truncated: false } as never;
      }
      if (operation === "apps.create") {
        return { app: app(), replayed: false } as never;
      }
      if (operation === "apps.get") return detail() as never;
      if (operation === "apps.runtime.availableCatalog") {
        return {
          appId: APP_ID,
          catalogDigest: SHA256_A,
          tools: [
            {
              identity: { serverId: "status", toolName: "read" },
              modelName: "status_read",
              programmaticPath: ["status", "read"],
              title: "Read status",
              inputSchema: { type: "object" },
              source: "opengeni",
              effect: "read",
              replaySafety: "safe",
              openWorld: false,
              approval: "none",
              supportedSurfaces: ["app"],
              requiredPermissions: [],
            },
          ],
        } as never;
      }
      if (operation === "apps.toolPolicy.create") {
        const value = input as OpenGeniAppsControlOperationMap["apps.toolPolicy.create"]["input"];
        appVersion += 1;
        policy = {
          id: POLICY_ID,
          accountId: ACCOUNT_ID,
          workspaceId: WORKSPACE_ID,
          appId: APP_ID,
          revision: 1,
          catalogDigest: value.request.catalogDigest,
          allowedTools: value.request.allowedTools,
          createdBySubjectId: "subject-1",
          createdAt: NOW,
        };
        return detail() as never;
      }
      if (operation === "apps.source.begin") {
        const value = input as OpenGeniAppsControlOperationMap["apps.source.begin"]["input"];
        source = {
          id: SOURCE_ID,
          accountId: ACCOUNT_ID,
          workspaceId: WORKSPACE_ID,
          appId: APP_ID,
          revision: 1,
          format: "portable_tar_v1",
          status: "uploading",
          contentSha256: value.request.contentSha256,
          sizeBytes: value.request.sizeBytes,
          fileCount: null,
          failureCode: null,
          sourceSessionId: null,
          sourceTurnId: null,
          sourceAttemptId: null,
          sourceExecutionGeneration: null,
          createdBySubjectId: "subject-1",
          createdAt: NOW,
          verifiedAt: null,
        };
        return {
          sourceRevision: source,
          stagingUpload: signedUpload("source"),
          replayed: false,
        } as never;
      }
      if (operation === "apps.source.complete") {
        const value = input as OpenGeniAppsControlOperationMap["apps.source.complete"]["input"];
        source = {
          ...source!,
          status: "ready",
          fileCount: value.request.fileCount,
          verifiedAt: NOW,
        };
        latestSourceRevisionId = SOURCE_ID;
        appVersion += 1;
        return detail() as never;
      }
      if (operation === "apps.build.prepare") {
        const value = input as OpenGeniAppsControlOperationMap["apps.build.prepare"]["input"];
        buildManifest = value.request.manifest;
        build = {
          id: BUILD_ID,
          accountId: ACCOUNT_ID,
          workspaceId: WORKSPACE_ID,
          appId: APP_ID,
          sourceRevisionId: SOURCE_ID,
          toolPolicyRevisionId: POLICY_ID,
          revision: 1,
          status: "uploading",
          manifestSha256: value.request.manifestSha256,
          entryPath: value.request.manifest.entryPath,
          fileCount: value.request.manifest.files.length,
          totalBytes: value.request.manifest.totalBytes,
          checks: value.request.checks,
          receiptDigest: null,
          failureCode: null,
          createdBySubjectId: "subject-1",
          createdAt: NOW,
          verifiedAt: null,
        };
        return {
          build,
          uploads: [
            {
              path: value.request.manifest.files[0]!.path,
              stagingUpload: signedUpload("build-first"),
            },
          ],
          nextCursor: "next-build-page",
          replayed: false,
        } as never;
      }
      if (operation === "apps.build.uploads.list") {
        return {
          buildId: BUILD_ID,
          uploads: buildManifest!.files.slice(1).map((file, index) => ({
            path: file.path,
            stagingUpload: signedUpload(`build-${index + 2}`),
          })),
          nextCursor: null,
        } as never;
      }
      if (operation === "apps.build.complete") {
        build = {
          ...build!,
          status: "succeeded",
          receiptDigest: SHA256_B,
          verifiedAt: NOW,
        };
        latestBuildId = BUILD_ID;
        appVersion += 1;
        return { app: app(), build, replayed: false } as never;
      }
      if (operation === "apps.release.promote") {
        release = {
          id: RELEASE_ID,
          accountId: ACCOUNT_ID,
          workspaceId: WORKSPACE_ID,
          appId: APP_ID,
          buildId: BUILD_ID,
          sourceRevisionId: SOURCE_ID,
          toolPolicyRevisionId: POLICY_ID,
          revision: 1,
          status: "ready",
          manifestSha256: build!.manifestSha256,
          entryPath: build!.entryPath,
          fileCount: build!.fileCount,
          totalBytes: build!.totalBytes,
          buildReceiptDigest: SHA256_B,
          createdBySubjectId: "subject-1",
          createdAt: NOW,
        };
        appVersion += 1;
        return { app: app(), release, replayed: false } as never;
      }
      if (operation === "apps.preview.create") {
        preview = {
          id: PREVIEW_ID,
          accountId: ACCOUNT_ID,
          workspaceId: WORKSPACE_ID,
          appId: APP_ID,
          releaseId: RELEASE_ID,
          status: "active",
          createdBySubjectId: "subject-1",
          createdAt: NOW,
          expiresAt: LATER,
          revokedAt: null,
        };
        return {
          preview,
          url: "https://preview.example.test/run",
          replayed: false,
        } as never;
      }
      if (operation === "apps.publish") {
        activeReleaseId = RELEASE_ID;
        appVersion += 1;
        return { app: app(), release: release!, replayed: false } as never;
      }
      throw new Error(`Unexpected Apps operation ${operation}.`);
    },
  };
  return { calls, client: new OpenGeniAppsClient(transport) };
}

describe("og-app CLI", () => {
  test("initializes, validates, and deterministically packs a browser-ready static app", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-app-authoring-"));
    temporaryRoots.push(root);
    const output = io(root);

    expect(await runOgAppCli(["init", "status", "--name", "Status console"], output.io)).toBe(0);
    const entry = await readFile(join(root, "status", "index.html"), "utf8");
    expect(entry).toContain("Status console");
    expect(entry).not.toContain("@opengeni/app-sdk");

    expect(await runOgAppCli(["validate", "status"], output.io)).toBe(0);
    expect(await runOgAppCli(["pack", "status"], output.io)).toBe(0);
    const archivePath = join(root, "status.ogapp.tar");
    const firstArchive = new Uint8Array(await readFile(archivePath));
    expect(inspectPortableAppArchive(firstArchive).sourceManifest.slug).toBe("status-console");

    await rm(archivePath);
    expect(await runOgAppCli(["pack", "status"], output.io)).toBe(0);
    expect(new Uint8Array(await readFile(archivePath))).toEqual(firstArchive);
    expect(output.stderr).toEqual([]);
  });

  test("rejects oversized source files before reading them into memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-app-pack-limit-"));
    temporaryRoots.push(root);
    const output = io(root);
    expect(await runOgAppCli(["init", "status", "--name", "Status console"], output.io)).toBe(0);
    const oversizedPath = join(root, "status", "oversized.bin");
    await writeFile(oversizedPath, "");
    await truncate(oversizedPath, 32 * 1024 * 1024 + 1);
    const archivePath = join(root, "status.ogapp.tar");

    await expect(
      runOgAppCli(["pack", "status", "--output", archivePath], output.io),
    ).rejects.toThrow("33554432-byte limit");
    await expect(stat(archivePath)).rejects.toThrow();
  });

  test("deploys and resumes one checked App release without persisting credentials or signed URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-app-deploy-"));
    temporaryRoots.push(root);
    const sessionCookie = "better-auth.session_token=must-not-persist";
    const output = io(root, { OPENGENI_SESSION_COOKIE: sessionCookie });
    expect(await runOgAppCli(["init", "status", "--name", "Status console"], output.io)).toBe(0);
    output.stdout.splice(0);

    const fixture = deployFixture();
    const checks: AppBuildCheckReceipt["kind"][] = [];
    const uploads: Array<{
      url: string;
      headers: Record<string, string>;
      byteLength: number;
    }> = [];
    const clientInputs: unknown[] = [];
    const args = [
      "deploy",
      "status",
      "--workspace",
      WORKSPACE_ID,
      "--base-url",
      "https://api.example.test",
      "--deployment-id",
      DEPLOYMENT_ID,
      "--typecheck-command",
      "bun run typecheck",
      "--test-command",
      "bun test",
      "--build-command",
      "bun run build",
      "--allow-tool",
      "status/read",
      "--preview",
      "--publish",
      "--reason",
      "Publish tested status console",
    ];
    const dependencies = {
      createAppsClient(input: unknown) {
        clientInputs.push(input);
        return fixture.client;
      },
      runCheck(kind: AppBuildCheckReceipt["kind"]) {
        checks.push(kind);
        return checkReceipt(kind);
      },
      async putSignedUpload(
        upload: { url: string; headers: Record<string, string> },
        bytes: Uint8Array,
      ) {
        uploads.push({
          url: upload.url,
          headers: upload.headers,
          byteLength: bytes.byteLength,
        });
      },
    };

    expect(await runOgAppCli(args, output.io, dependencies)).toBe(0);
    expect(checks).toEqual(["typecheck", "test", "build"]);
    expect(uploads).toHaveLength(3);
    expect(uploads.every((upload) => upload.byteLength > 0)).toBe(true);
    expect(uploads.every((upload) => !Object.keys(upload.headers).includes("authorization"))).toBe(
      true,
    );
    expect(clientInputs).toEqual([
      {
        baseUrl: "https://api.example.test",
        sessionCookie,
      },
    ]);

    const result = JSON.parse(output.stdout.at(-1)!) as Record<string, unknown>;
    expect(result).toMatchObject({
      deploymentId: DEPLOYMENT_ID,
      appId: APP_ID,
      sourceRevisionId: SOURCE_ID,
      buildId: BUILD_ID,
      releaseId: RELEASE_ID,
      previewId: PREVIEW_ID,
      previewUrl: "https://preview.example.test/run",
      published: true,
    });
    const statePath = join(root, ".opengeni", "deployments", `${DEPLOYMENT_ID}.json`);
    const stateText = await readFile(statePath, "utf8");
    expect(stateText).not.toContain(sessionCookie);
    expect(stateText).not.toContain("must-not-persist");
    expect(stateText).not.toContain("storage.example.test");
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(stateText)).toMatchObject({
      deploymentId: DEPLOYMENT_ID,
      allowedToolSelectors: ["status/read"],
      toolPolicyRevisionId: POLICY_ID,
      sourceCompleted: true,
      buildCompleted: true,
      published: true,
    });

    const mutatingOperations = new Set<OpenGeniAppsControlOperation>([
      "apps.create",
      "apps.toolPolicy.create",
      "apps.source.begin",
      "apps.source.complete",
      "apps.build.prepare",
      "apps.build.complete",
      "apps.release.promote",
      "apps.preview.create",
      "apps.publish",
    ]);
    const mutationCount = fixture.calls.filter(({ operation }) =>
      mutatingOperations.has(operation),
    ).length;
    const uploadCount = uploads.length;
    const checkCount = checks.length;
    output.stdout.splice(0);
    expect(await runOgAppCli(args, output.io, dependencies)).toBe(0);
    expect(checks).toHaveLength(checkCount);
    expect(uploads).toHaveLength(uploadCount);
    expect(fixture.calls.filter(({ operation }) => mutatingOperations.has(operation))).toHaveLength(
      mutationCount,
    );
    expect(JSON.parse(output.stdout.at(-1)!)).toMatchObject({
      deploymentId: DEPLOYMENT_ID,
      appId: APP_ID,
      previewId: PREVIEW_ID,
      published: true,
    });
  });

  test("removes Apps credentials from user-supplied check command environments", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-app-check-env-"));
    temporaryRoots.push(root);
    const output = io(root, {
      OPENGENI_SESSION_COOKIE: "better-auth.session_token=cli-only",
    });
    expect(await runOgAppCli(["init", "status", "--name", "Status console"], output.io)).toBe(0);
    const previousApiKey = process.env.OPENGENI_API_KEY;
    const previousSessionCookie = process.env.OPENGENI_SESSION_COOKIE;
    process.env.OPENGENI_API_KEY = "api-key-must-not-reach-checks";
    process.env.OPENGENI_SESSION_COOKIE = "session-must-not-reach-checks";
    try {
      await expect(
        runOgAppCli(
          [
            "deploy",
            "status",
            "--workspace",
            WORKSPACE_ID,
            "--base-url",
            "https://api.example.test",
            "--deployment-id",
            DEPLOYMENT_ID,
            "--typecheck-command",
            'test -z "$OPENGENI_API_KEY" && test -z "$OPENGENI_SESSION_COOKIE"',
            "--test-command",
            'test -z "$OPENGENI_API_KEY" && test -z "$OPENGENI_SESSION_COOKIE"',
            "--build-command",
            'test -z "$OPENGENI_API_KEY" && test -z "$OPENGENI_SESSION_COOKIE"',
          ],
          output.io,
          {
            createAppsClient() {
              throw new Error("checks completed before client creation");
            },
          },
        ),
      ).rejects.toThrow("checks completed before client creation");
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENGENI_API_KEY;
      else process.env.OPENGENI_API_KEY = previousApiKey;
      if (previousSessionCookie === undefined) delete process.env.OPENGENI_SESSION_COOKIE;
      else process.env.OPENGENI_SESSION_COOKIE = previousSessionCookie;
    }
  });
});
