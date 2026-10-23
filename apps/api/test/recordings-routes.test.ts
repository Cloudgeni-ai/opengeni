import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("recordings-routes");
  if (!acquired) throw new Error("Recording route tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const memberPermissions = ["workspace:read", "sessions:read", "sessions:create"];
type Started = Parameters<NonNullable<SessionWorkflowClient["startRecordingWorkflow"]>>[0];

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Recording fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "workspace:admin",
      "members:manage",
      "sessions:read",
      "sessions:create",
      "account:admin",
    ],
  });
  const objects = new Map<string, Uint8Array>();
  const objectStorage = {
    createPutUrl: async (args: { key: string; contentType: string; sha256?: string | null }) => ({
      url: `https://storage.example/${args.key}?signed=put`,
      requiredHeaders: { "content-type": args.contentType },
      expiresAt: new Date(Date.now() + 900_000),
    }),
    createGetUrl: async (args: { key: string }) => ({
      url: `https://storage.example/${args.key}?signed=get`,
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
    headObject: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { ContentLength: bytes.byteLength } : null;
    },
    getObjectBytes: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { bytes } : null;
    },
  };
  const started: Started[] = [];
  const app = createApp({
    db: db.db,
    bus: new MemoryEventBus(),
    settings: testSettings({
      productAccessMode: "configured",
      sandboxBackend: "none",
      publicBaseUrl: "https://opengeni.example",
      environmentsEncryptionKey: randomBytes(32).toString("base64"),
    }),
    objectStorage,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
      startRecordingWorkflow: async (input: Started) => {
        started.push(input);
      },
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async () => {
    const identity = await ensureExternalIdentity(db.db, {
      accountId,
      source,
      externalId: crypto.randomUUID(),
    });
    const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        identity: { source, externalId: identity.externalId },
        permissions: memberPermissions,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(added.status).toBe(200);
    const headers = {
      ...service,
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({ mode: "external", identity: { source, externalId: identity.externalId } }),
      ),
    };
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await app.request(`/v1/workspaces/${workspace.id}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    return { subjectId: identity.subjectId, call };
  };
  return {
    accountId,
    workspaceId: workspace.id,
    objects,
    started,
    owner: await person(),
    other: await person(),
  };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("recording routes", () => {
  test("capture, upload, finalize and re-run start the worker; private stays Only me", async () => {
    const scope = await fixture();
    const recordingId = crypto.randomUUID();
    const created = await scope.owner.call("POST", "/recordings", {
      recordingId,
      title: "Design review",
      tracks: [
        { trackNumber: 0, source: "microphone", mimeType: "audio/webm;codecs=opus" },
        { trackNumber: 1, source: "system", mimeType: "audio/webm;codecs=opus" },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: recordingId,
      visibility: "private",
      state: "capturing",
    });
    expect(
      (
        await scope.owner.call("POST", "/recordings", {
          recordingId,
          tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
        })
      ).status,
    ).toBe(200);
    expect((await scope.other.call("GET", `/recordings/${recordingId}`)).status).toBe(404);
    expect((await scope.other.call("GET", "/recordings")).body.recordings).toEqual([]);

    const audio = [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]), new Uint8Array([2, 3, 4])];
    for (const trackNumber of [0, 1]) {
      const uploads = await scope.owner.call("POST", `/recordings/${recordingId}/uploads`, {
        trackNumber,
        chunks: audio.map((bytes, chunkNumber) => ({
          chunkNumber,
          byteLength: bytes.byteLength,
          sha256: sha(bytes),
          startMilliseconds: chunkNumber * 1_000,
          durationMilliseconds: 1_000,
        })),
      });
      expect(uploads.status).toBe(200);
      expect(uploads.body.uploads).toHaveLength(2);
      expect(uploads.body.uploads[0]).toMatchObject({
        uploaded: false,
        method: "PUT",
        headers: { "content-type": "audio/webm" },
      });
      const key = (url: string) => new URL(url).pathname.slice(1);
      scope.objects.set(key(uploads.body.uploads[0].url), audio[0]!);
      const partial = await scope.owner.call("POST", `/recordings/${recordingId}/chunks/complete`, {
        trackNumber,
        chunkNumbers: [0, 1],
      });
      expect(partial.body).toEqual({ uploaded: [0], missing: [1] });
      scope.objects.set(key(uploads.body.uploads[1].url), audio[1]!);
      const complete = await scope.owner.call(
        "POST",
        `/recordings/${recordingId}/chunks/complete`,
        {
          trackNumber,
          chunkNumbers: [1],
        },
      );
      expect(complete.body).toEqual({ uploaded: [1], missing: [] });
    }
    expect(
      (await scope.other.call("POST", `/recordings/${recordingId}/finalize`, { tracks: [] }))
        .status,
    ).toBe(400);
    const finalized = await scope.owner.call("POST", `/recordings/${recordingId}/finalize`, {
      tracks: [
        { trackNumber: 0, chunkCount: 2 },
        { trackNumber: 1, chunkCount: 2 },
      ],
    });
    expect(finalized.status).toBe(200);
    expect(finalized.body.recording.state).toBe("processing");
    expect(finalized.body.transcript).toMatchObject({
      providerId: "elevenlabs",
      model: "scribe_v2",
      state: "queued",
    });
    expect(scope.started).toEqual([
      {
        kind: "transcript",
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        recordingId,
        versionId: finalized.body.transcript.id,
        ownerSubjectId: scope.owner.subjectId,
      },
    ]);
    // Finalizing again returns the same version and restarts a lost start.
    const again = await scope.owner.call("POST", `/recordings/${recordingId}/finalize`, {
      tracks: [
        { trackNumber: 0, chunkCount: 2 },
        { trackNumber: 1, chunkCount: 2 },
      ],
    });
    expect(again.body.transcript.id).toBe(finalized.body.transcript.id);
    const rerun = await scope.owner.call("POST", `/recordings/${recordingId}/transcripts`, {});
    expect(rerun).toMatchObject({
      status: 409,
      body: { error: { details: { code: "transcript_pending" } } },
    });
    expect(
      (
        await scope.owner.call("POST", `/recordings/${recordingId}/transcripts`, {
          transcription: { providerId: "elevenlabs", model: "nope" },
        })
      ).body.error.details.code,
    ).toBe("unknown_model");
    const audioLink = await scope.owner.call("GET", `/recordings/${recordingId}/tracks/0/audio`);
    expect(audioLink).toMatchObject({
      status: 409,
      body: { error: { details: { code: "audio_not_ready" } } },
    });
    const versions = await scope.owner.call("GET", `/recordings/${recordingId}/transcripts`);
    expect(versions.body.versions).toHaveLength(1);
    // Each issued upload URL is a recorded audit fact; the URL and object key never are.
    const audits = await shared.admin`
      select action, metadata from audit_events
      where account_id = ${scope.accountId} and target_id = ${recordingId}`;
    const issued = audits.filter((row) => row.action === "recording.signed_upload.issued");
    expect(issued.length).toBeGreaterThan(0);
    expect(JSON.stringify(issued)).not.toContain("storage.example");
    expect(JSON.stringify(issued)).not.toContain("workspaces/");
  });

  test("a workspace default shares new recordings; only the owner deletes", async () => {
    const scope = await fixture();
    await shared.admin`
      update workspaces set settings = settings || '{"recordings":{"defaultVisibility":"workspace"}}'::jsonb
      where id = ${scope.workspaceId}`;
    const recordingId = crypto.randomUUID();
    await scope.owner.call("POST", "/recordings", {
      recordingId,
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    });
    const seen = await scope.other.call("GET", `/recordings/${recordingId}`);
    expect(seen).toMatchObject({ status: 200, body: { visibility: "workspace" } });
    const renamed = await scope.other.call("PATCH", `/recordings/${recordingId}`, {
      title: "Kickoff",
    });
    expect(renamed).toMatchObject({ status: 200, body: { title: "Kickoff" } });
    expect(
      (await scope.other.call("PATCH", `/recordings/${recordingId}`, { visibility: "private" }))
        .status,
    ).toBe(403);
    expect((await scope.other.call("DELETE", `/recordings/${recordingId}`)).status).toBe(403);
    expect((await scope.owner.call("DELETE", `/recordings/${recordingId}`)).status).toBe(204);
    expect(scope.started.at(-1)).toMatchObject({ kind: "deletion", recordingId, versionId: null });
    expect((await scope.owner.call("GET", `/recordings/${recordingId}`)).status).toBe(404);
  });

  test("people and models", async () => {
    const scope = await fixture();
    const personId = crypto.randomUUID();
    const created = await scope.owner.call("POST", "/recording-people", {
      personId,
      displayName: "Kari Nordmann",
    });
    expect(created).toMatchObject({
      status: 201,
      body: { id: personId, displayName: "Kari Nordmann" },
    });
    expect(
      (await scope.other.call("GET", "/recording-people?query=kari")).body.people,
    ).toHaveLength(1);
    const models = await scope.owner.call("GET", "/recording-models");
    expect(models.body.default).toEqual({ providerId: "elevenlabs", model: "scribe_v2" });
    expect(models.body.models[0]).toMatchObject({
      providerId: "elevenlabs",
      model: "scribe_v2",
      available: false,
    });
  });
});
