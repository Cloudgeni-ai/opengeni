import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  signDelegatedAccessToken,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  fileOwnerContextForAgent,
  inProcessFileOwnerContext,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  bindSlackInteractionSession,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  completeFileUpload,
  createConnection,
  createDb,
  createSession,
  getOrCreateSlackInteraction,
  getSlackPrivateSessionOwnerSubjectId,
  initializeSessionStartAtomically,
  prepareGeneratedWorkspaceFile,
  prepareRetainedScreenshotArtifact,
  settleRetainedScreenshotArtifactReady,
  withSessionRlsActorContext,
  type DbClient,
  type SessionRlsActorContext,
} from "@opengeni/db";
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { registerFileRoutes } from "../src/routes/files";
import { importSlackReactionImage } from "../src/slack-reaction-files";

// A Slack bot DM (or private handoff) is fenced to the person it belongs to.
// The files that session produces must be fenced the same way: another member
// of the workspace can neither list nor download them.

const SECRET = "slack-private-session-files-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("slack-private-session-files");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function storageFixture() {
  const objects = new Map<string, { head: ObjectHead; bytes: Uint8Array }>();
  const signed: string[] = [];
  const storage = {
    bucket: "slack-private-test-bucket",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    async headObject(key: string) {
      return objects.get(key)?.head ?? null;
    },
    async putObjectIfAbsent(upload: {
      key: string;
      contentType: string;
      body: Uint8Array;
      sha256: string;
    }) {
      if (objects.has(upload.key)) return false;
      objects.set(upload.key, {
        bytes: upload.body,
        head: {
          ContentLength: upload.body.byteLength,
          ContentType: upload.contentType,
          Metadata: { sha256: upload.sha256 },
          VersionToken: "v1",
        },
      });
      return true;
    },
    async fileExists(file: { objectKey: string }) {
      return objects.has(file.objectKey);
    },
    async createGetUrl(args: { key: string }) {
      signed.push(args.key);
      return {
        url: `https://storage.example.test/${encodeURIComponent(args.key)}?signature=opaque`,
        expiresAt: new Date(Date.now() + 300_000),
      };
    },
  } as unknown as ObjectStorage;
  return { storage, objects, signed };
}

function routeApp(objectStorage: ObjectStorage): Hono {
  const app = new Hono();
  registerFileRoutes(app, {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
    db: client.db,
    objectStorage,
    managedAuth: null,
  } as unknown as ApiRouteDeps);
  return app;
}

function completePng(): Uint8Array {
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ]);
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `slack-private-account-${suffix}`,
    accountName: "Slack private files account",
    workspaceExternalSource: "test",
    workspaceExternalId: `slack-private-workspace-${suffix}`,
    workspaceName: "Slack private files workspace",
    subjectId: `user:owner-${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const { accountId, workspaceId } = owner;
  const colleagueSubjectId = `user:colleague-${suffix}`;
  const bearer = async (subjectId: string) =>
    `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId,
      workspaceId,
      subjectId,
      permissions: ["files:read"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}`;
  const teamId = `T${suffix.slice(0, 8)}`;
  const connection = await createConnection(client.db, {
    accountId,
    workspaceId,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    credentialEncrypted: "fixture-ciphertext",
    grantedScopes: ["app_mentions:read", "chat:write", "commands", "im:history"],
    verifiedInstallAt: new Date(),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: teamId,
      slackTeamName: "Fixture team",
      botId: "B_FIXTURE",
      botUserId: "U_FIXTURE_BOT",
      botDisplayName: "Opengeni",
      verifiedAt: new Date().toISOString(),
    },
  });
  // Slack sessions are created exactly like this: workspace-shared rows whose
  // privacy lives only on the interaction that reserved them.
  const slackSession = async (visibility: "private" | "workspace", channelId: string) => {
    const threadTs = `${Date.now()}.${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;
    const { interaction } = await getOrCreateSlackInteraction(client.db, {
      accountId,
      workspaceId,
      connectionId: connection.id,
      slackTeamId: teamId,
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      routeKey: `${channelId}:${threadTs}`,
      triggeringProviderEventId: `E${crypto.randomUUID()}`,
      owningSubjectId: owner.subjectId,
      visibility,
    });
    const session = await createSession(client.db, {
      accountId,
      workspaceId,
      requestedSessionId: interaction.sessionReservationId,
      initialMessage: "a Slack task",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: owner.subjectId },
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const bound = await bindSlackInteractionSession(client.db, {
      ...interaction,
      owningSubjectId: owner.subjectId,
      sessionId: session.id,
    });
    expect(bound?.sessionId).toBe(session.id);
    return { interaction, session };
  };
  return {
    accountId,
    workspaceId,
    owner,
    colleagueSubjectId,
    ownerAuthorization: await bearer(owner.subjectId),
    colleagueAuthorization: await bearer(colleagueSubjectId),
    slackSession,
    connection,
    teamId,
  };
}

async function listedFileIds(app: Hono, workspaceId: string, authorization: string) {
  const response = await app.request(`http://x/v1/workspaces/${workspaceId}/files?limit=50`, {
    headers: { authorization },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { files: { id: string }[] };
  return body.files.map((file) => file.id);
}

async function downloadStatus(
  app: Hono,
  workspaceId: string,
  fileId: string,
  authorization: string,
) {
  const response = await app.request(
    `http://x/v1/workspaces/${workspaceId}/files/${fileId}/download-url`,
    { method: "POST", headers: { authorization } },
  );
  return response.status;
}

async function createTurnFile(
  f: Awaited<ReturnType<typeof fixture>>,
  actor: SessionRlsActorContext,
  name: string,
  storage: ReturnType<typeof storageFixture>,
) {
  const fileId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  const bytes = new TextEncoder().encode(`${name} bytes`);
  const objectKey = `workspaces/${f.workspaceId}/files/${fileId}/original/${name}`;
  await withSessionRlsActorContext(actor, async () => {
    await prepareGeneratedWorkspaceFile(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      fileId,
      uploadId,
      filename: name,
      safeFilename: name,
      contentType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bucket: storage.storage.bucket,
      objectKey,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await completeFileUpload(client.db, f.workspaceId, uploadId);
  });
  storage.objects.set(objectKey, {
    bytes,
    head: { ContentLength: bytes.byteLength, ContentType: "text/plain", Metadata: {} },
  });
  return fileId;
}

async function claimAttempt(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
  await initializeSessionStartAtomically(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `slack-private-files-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`fixture attempt was not claimed`);
  const grant: AccessGrant = {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    subjectId: "worker:slack-private-files",
    permissions: ["files:read", "sessions:create", "sessions:control"],
    principalKind: "agent_attempt",
    metadata: {
      sessionId,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  };
  return { attemptId, turnId: claim.turn.id, grant };
}

describe("files produced for a private Slack session", () => {
  test("an image imported from a bot DM is listed and downloadable only by its owner", async () => {
    if (!available) return;
    const f = await fixture();
    const storage = storageFixture();
    const { interaction } = await f.slackSession("private", "D_PRIVATE");
    const imported = await importSlackReactionImage(
      { db: client.db, objectStorage: storage.storage },
      {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        connectionId: f.connection.id,
        slackTeamId: f.teamId,
        slackChannelId: interaction.slackChannelId,
        slackMessageTs: interaction.slackThreadTs!,
        privateOwnerSubjectId: f.owner.subjectId,
      },
      {
        fileId: "F_PRIVATE",
        filename: "photo.png",
        contentType: "image/png",
        bytes: completePng(),
      },
      1,
    );
    const fileId = imported.resource.fileId;
    const [row] = await shared!.admin<{ owners: string[] | null }[]>`
      select private_owner_subject_ids as owners from files where id = ${fileId}`;
    expect(row?.owners).toEqual([f.owner.subjectId]);

    const app = routeApp(storage.storage);
    expect(await listedFileIds(app, f.workspaceId, f.ownerAuthorization)).toContain(fileId);
    expect(await listedFileIds(app, f.workspaceId, f.colleagueAuthorization)).not.toContain(fileId);
    expect(await downloadStatus(app, f.workspaceId, fileId, f.colleagueAuthorization)).toBe(404);
    expect(await downloadStatus(app, f.workspaceId, fileId, f.ownerAuthorization)).toBe(200);

    // The Slack entry point may attach the owner's image to their own private
    // session, and to nobody else's.
    const attaching = [{ kind: "file", fileId }];
    const ownerGrant = { ...f.owner, principalKind: "human_session" } as AccessGrant;
    expect(
      await inProcessFileOwnerContext(
        { db: client.db },
        ownerGrant,
        interaction.sessionReservationId,
        attaching,
      ),
    ).toEqual({ subjectId: f.owner.subjectId, privateFileOwnerSubjectId: f.owner.subjectId });
    expect(
      await inProcessFileOwnerContext(
        { db: client.db },
        { ...ownerGrant, subjectId: f.colleagueSubjectId },
        interaction.sessionReservationId,
        attaching,
      ),
    ).toBeUndefined();
  });

  test("files an agent turn produces in a bot DM belong to its owner; a shared thread's do not", async () => {
    if (!available) return;
    const f = await fixture();
    const storage = storageFixture();
    const privateSlack = await f.slackSession("private", "D_TURN");
    const sharedSlack = await f.slackSession("workspace", "C_SHARED");
    expect(
      await getSlackPrivateSessionOwnerSubjectId(client.db, f.workspaceId, privateSlack.session.id),
    ).toBe(f.owner.subjectId);
    expect(
      await getSlackPrivateSessionOwnerSubjectId(client.db, f.workspaceId, sharedSlack.session.id),
    ).toBeNull();

    const privateAttempt = await claimAttempt(f, privateSlack.session.id);
    const privateActor = await fileOwnerContextForAgent(
      { db: client.db },
      privateAttempt.grant,
      "files:read",
    );
    expect(privateActor.privateFileOwnerSubjectId).toBe(f.owner.subjectId);
    const sharedAttempt = await claimAttempt(f, sharedSlack.session.id);
    const sharedActor = await fileOwnerContextForAgent(
      { db: client.db },
      sharedAttempt.grant,
      "files:read",
    );
    expect(sharedActor.privateFileOwnerSubjectId).toBeNull();

    const privateFile = await createTurnFile(f, privateActor, "dm-report.txt", storage);
    const sharedFile = await createTurnFile(f, sharedActor, "thread-report.txt", storage);
    const app = routeApp(storage.storage);
    const colleagueSees = await listedFileIds(app, f.workspaceId, f.colleagueAuthorization);
    expect(colleagueSees).not.toContain(privateFile);
    expect(colleagueSees).toContain(sharedFile);
    expect(await downloadStatus(app, f.workspaceId, privateFile, f.colleagueAuthorization)).toBe(
      404,
    );
    const ownerSees = await listedFileIds(app, f.workspaceId, f.ownerAuthorization);
    expect(ownerSees).toContain(privateFile);
    expect(ownerSees).toContain(sharedFile);
    expect(await downloadStatus(app, f.workspaceId, privateFile, f.ownerAuthorization)).toBe(200);
  });

  test("session screenshot routes apply the session's read fence to people", async () => {
    if (!available) return;
    const f = await fixture();
    const storage = storageFixture();
    const { session } = await f.slackSession("private", "D_SHOTS");
    const attempt = await claimAttempt(f, session.id);
    const artifactId = crypto.randomUUID();
    const settlementKey = `api:${crypto.randomUUID()}`;
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const objectKey = `workspaces/${f.workspaceId}/files/${artifactId}/retained/computer-screenshot.png`;
    // A screenshot retained without a personal owner, as before this fix: the
    // session fence alone must keep it from other people.
    await withSessionRlsActorContext(
      { subjectId: "service:agent-turn", privateFileOwnerSubjectId: null },
      async () => {
        await prepareRetainedScreenshotArtifact(client.db, {
          artifactId,
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sessionId: session.id,
          turnId: attempt.turnId,
          attemptId: attempt.attemptId,
          settlementKey,
          toolCallId: `call-${artifactId}`,
          toolOutputId: `output-${artifactId}`,
          mediaType: "image/png",
          sizeBytes: bytes.byteLength,
          sha256: "b".repeat(64),
          width: 1,
          height: 1,
          retentionExpiresAt: new Date(Date.now() + 60_000),
          bucket: storage.storage.bucket,
          objectKey,
          workspaceQuotaBytes: 100 * 1024 * 1024,
        });
        await settleRetainedScreenshotArtifactReady(client.db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          artifactId,
          settlementKey,
        });
      },
    );
    const app = routeApp(storage.storage);
    const url = `http://x/v1/workspaces/${f.workspaceId}/sessions/${session.id}/artifacts/${artifactId}`;
    for (const denied of [url, `${url}/content`]) {
      const response = await app.request(denied, {
        headers: { authorization: f.colleagueAuthorization },
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ available: false, reason: "deleted" });
    }
    const ownerMetadata = await app.request(url, {
      headers: { authorization: f.ownerAuthorization },
    });
    expect(ownerMetadata.status).toBe(200);
    expect(await ownerMetadata.json()).toMatchObject({ available: true, artifactId });
  });
});
