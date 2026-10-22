import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MODEL_ATTACHMENT_REFS_FIELD, type AccessGrant } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createFileUpload,
  createSession,
  getFilesForSubject,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  assertFileResourcesRemainAuthorized,
  workerMayReadFileSource,
} from "../src/activities/agent-turn/file-resources";
import { resolveImageGenerationReferencesForTool } from "../src/activities/image-generation-references";
import { createModelHistoryAttachmentProjector } from "../src/activities/run-input";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("file-resource-host-access");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("a host revocation blocks an already selected File before worker materialization", async () => {
  const suffix = crypto.randomUUID();
  const subjectId = `subject-${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "File host access",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "File host access",
    subjectId,
  });
  const membership = access.workspaceGrants[0]!;
  const accountId = membership.accountId;
  const workspaceId = membership.workspaceId!;
  const source = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Example",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const fileId = crypto.randomUUID();
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const digest = createHash("sha256").update(imageBytes).digest("hex");
  await createFileUpload(client.db, {
    accountId,
    workspaceId,
    fileId,
    sourceSessionId: source.id,
    filename: "example.png",
    safeFilename: "example.png",
    contentType: "image/png",
    sizeBytes: imageBytes.length,
    bucket: "fixture",
    objectKey: `workspaces/${workspaceId}/files/${fileId}/original/example.png`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await shared.admin`update files set status = 'ready', sha256 = ${digest} where id = ${fileId}`;
  const grant: AccessGrant = {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["files:read"],
  };
  let allowed = true;
  let mcpAllowed = true;
  const port = {
    authorizeSession: async ({ surface }: { surface: string }) =>
      allowed && (surface !== "first_party_mcp" || mcpAllowed)
        ? ({ allowed: true } as const)
        : ({ allowed: false, reason: "revoked" } as const),
    resolveListScope: async () => ({ kind: "all" as const }),
  };
  const check = () =>
    assertFileResourcesRemainAuthorized(
      client.db,
      accountId,
      workspaceId,
      subjectId,
      [{ kind: "file" as const, fileId }],
      { grant, port, requireMcpSurface: true },
    );
  await expect(check()).resolves.toBeUndefined();
  mcpAllowed = false;
  await expect(check()).rejects.toThrow("no longer authorized");
  mcpAllowed = true;
  allowed = false;
  await expect(check()).rejects.toThrow("no longer authorized");
  const workerAuthorization = { grant, port, requireMcpSurface: false };
  const loadVisible = async (fileIds: readonly string[]) => {
    const files = await getFilesForSubject(client.db, {
      accountId,
      workspaceId,
      subjectId,
      fileIds,
    });
    const visible = await Promise.all(
      files.map((file) => workerMayReadFileSource(client.db, subjectId, file, workerAuthorization)),
    );
    return files.filter((_, index) => visible[index]);
  };
  let historyReads = 0;
  const project = createModelHistoryAttachmentProjector(
    { supportsImageInput: true, inputFileMediaTypes: [] },
    async () => {
      historyReads++;
      return imageBytes;
    },
    loadVisible,
  );
  const history = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Example" }],
      [MODEL_ATTACHMENT_REFS_FIELD]: [{ kind: "file", fileId }],
    },
  ];
  expect(JSON.stringify(await project(history))).not.toContain("data:image/");
  expect(historyReads).toBe(0);
  let imageReferenceReads = 0;
  const imageReference = await resolveImageGenerationReferencesForTool({
    db: client.db,
    objectStorage: {
      getFileBytes: async () => {
        imageReferenceReads++;
        return imageBytes;
      },
    } as never,
    accountId,
    workspaceId,
    subjectId,
    references: [{ kind: "file", fileId }],
    authorizeFile: (file) =>
      workerMayReadFileSource(client.db, subjectId, file, workerAuthorization),
  });
  expect(imageReference).toMatchObject({
    status: "rejected",
    result: { code: "reference_unavailable" },
  });
  expect(imageReferenceReads).toBe(0);
}, 180_000);
