import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SessionWorkflowClient, TranscriptionService } from "@opengeni/core";
import {
  createConnection,
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  encryptEnvironmentValue,
  ensureExternalIdentity,
  setWorkspaceAllowance,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createSpeechToTextDeployment } from "@opengeni/core/transcription-service";
import { createApp, type AppDependencies } from "../src/app";
import { meetingLanguage } from "../src/routes/recordings";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("recordings-routes");
  if (!acquired) throw new Error("Recording route tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
// Releasing the shared database can take longer than the default hook timeout
// on a busy machine.
afterAll(async () => {
  await db?.close();
  await shared?.release();
}, 60_000);

const noop = async () => undefined;
const encryptionKey = Buffer.alloc(32, 7);
const memberPermissions = ["workspace:read", "sessions:read", "sessions:create"];
type Started = Parameters<NonNullable<SessionWorkflowClient["startRecordingWorkflow"]>>[0];

async function fixture(
  options: {
    transcription?: TranscriptionService;
    settings?: Parameters<typeof testSettings>[0];
    /** What the deployment's speech providers call, such as Azure sign-in. */
    speechFetch?: typeof fetch;
  } = {},
) {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Recording fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  const serviceKey = await createOrganizationApiKey(db.db, {
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
      "api_keys:manage",
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
  const settings = testSettings({
    productAccessMode: "configured",
    sandboxBackend: "none",
    publicBaseUrl: "https://opengeni.example",
    environmentsEncryptionKey: encryptionKey.toString("base64"),
    ...options.settings,
  });
  const app = createApp({
    db: db.db,
    bus: new MemoryEventBus(),
    settings,
    ...(options.speechFetch
      ? {
          speechToText: createSpeechToTextDeployment(
            { settings, db: db.db },
            { fetch: options.speechFetch },
          ),
        }
      : {}),
    objectStorage,
    ...(options.transcription ? { transcription: options.transcription } : {}),
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
  const admin = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/v1/workspaces/${workspace.id}${path}`, {
      method,
      headers: service,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return {
    accountId,
    workspaceId: workspace.id,
    serviceSubjectId: `api_key:${serviceKey.id}`,
    objects,
    started,
    admin,
    owner: await person(),
    other: await person(),
  };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("recording routes", () => {
  test("a used-up usage allowance refuses new recordings and re-runs", async () => {
    const scope = await fixture();
    const recordingId = crypto.randomUUID();
    const tracks = [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }];
    expect((await scope.owner.call("POST", "/recordings", { recordingId, tracks })).status).toBe(
      201,
    );
    await setWorkspaceAllowance(db.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      actorSubjectId: scope.serviceSubjectId,
      includedCredits: 0,
      period: "monthly",
      unbilledUsage: "list_price",
      expectedVersion: 0,
    });
    const refused = await scope.owner.call("POST", "/recordings", {
      recordingId: crypto.randomUUID(),
      tracks,
    });
    expect(refused).toMatchObject({
      status: 402,
      body: { error: { code: "allowance_exhausted", details: { scope: "workspace" } } },
    });
    expect(
      (await scope.owner.call("POST", `/recordings/${recordingId}/transcripts`, {})).status,
    ).toBe(402);
    expect(
      (
        await scope.owner.call("POST", `/recordings/${recordingId}/live-session`, {
          trackNumber: 0,
        })
      ).status,
    ).toBe(402);
  });

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

  test("notes: anyone who can see the meeting saves them; a stale revision is a 409", async () => {
    const scope = await fixture();
    const recordingId = crypto.randomUUID();
    await scope.owner.call("POST", "/recordings", {
      recordingId,
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    });
    const path = `/recordings/${recordingId}/notes`;
    expect(await scope.owner.call("GET", path)).toEqual({ status: 200, body: { notes: [] } });
    const saved = await scope.owner.call("PUT", `${path}/notes`, {
      body: "## Decisions\n\n- Ship it",
      expectedRevision: 0,
    });
    expect(saved).toMatchObject({
      status: 200,
      body: { kind: "notes", revision: 1, updatedBy: { subjectId: scope.owner.subjectId } },
    });
    expect(
      await scope.owner.call("PUT", `${path}/notes`, { body: "older", expectedRevision: 0 }),
    ).toMatchObject({ status: 409, body: { error: { details: { code: "notes_changed" } } } });
    expect((await scope.owner.call("PUT", `${path}/agenda`, { body: "x" })).status).toBe(404);
    expect(
      (await scope.owner.call("PUT", `${path}/notepad`, { body: "x".repeat(262_145) })).status,
    ).toBe(400);
    // A private meeting's notes are as hidden as the meeting.
    expect((await scope.other.call("GET", path)).status).toBe(404);
    expect((await scope.other.call("PUT", `${path}/notes`, { body: "mine now" })).status).toBe(404);
  });

  test("a dictation is private, one microphone, heard by voice input and never listed", async () => {
    const selected: Array<Record<string, unknown>> = [];
    const transcription: TranscriptionService = {
      limits: () => ({ maxDurationSeconds: 600, maxSizeBytes: 25_000_000, acceptedMimeTypes: [] }),
      available: () => true,
      selectProvider: (context) => {
        selected.push({ ...context });
        return "openai";
      },
      transcribe: async () => {
        throw new Error("the worker transcribes dictations");
      },
    };
    const scope = await fixture({ transcription });
    await shared.admin`
      update workspaces set settings = settings
        || '{"voiceInput":{"enabled":true,"preferredProvider":"openai","fallbackEnabled":false}}'::jsonb
      where id = ${scope.workspaceId}`;
    const mic = [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm;codecs=opus" }];
    expect(
      (
        await scope.owner.call("POST", "/recordings", {
          recordingId: crypto.randomUUID(),
          purpose: "dictation",
          tracks: [...mic, { trackNumber: 1, source: "system", mimeType: "audio/webm" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await scope.owner.call("POST", "/recordings", {
          recordingId: crypto.randomUUID(),
          purpose: "dictation",
          tracks: mic,
          transcription: { providerId: "elevenlabs", model: "scribe_v2" },
        })
      ).status,
    ).toBe(400);
    const recordingId = crypto.randomUUID();
    const created = await scope.owner.call("POST", "/recordings", {
      recordingId,
      purpose: "dictation",
      visibility: "workspace",
      tracks: mic,
    });
    expect(created).toMatchObject({
      status: 201,
      body: { purpose: "dictation", visibility: "private", title: "Dictation" },
    });
    // The same id as a meeting is refused, not quietly turned into one.
    expect(
      (await scope.owner.call("POST", "/recordings", { recordingId, tracks: mic })).body,
    ).toMatchObject({ error: { details: { code: "purpose_mismatch" } } });
    expect((await scope.owner.call("GET", "/recordings")).body.recordings).toEqual([]);
    expect(
      (await scope.owner.call("GET", "/recordings?purpose=dictation")).body.recordings.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([recordingId]);
    expect(
      (await scope.other.call("GET", "/recordings?purpose=dictation")).body.recordings,
    ).toEqual([]);
    expect((await scope.owner.call("GET", "/recordings?purpose=browser")).status).toBe(400);
    expect((await scope.other.call("GET", `/recordings/${recordingId}`)).status).toBe(404);
    expect(
      (await scope.owner.call("PATCH", `/recordings/${recordingId}`, { visibility: "workspace" }))
        .status,
    ).toBe(409);
    expect(
      (
        await scope.owner.call("POST", `/recordings/${recordingId}/live-session`, {
          trackNumber: 0,
        })
      ).status,
    ).toBe(409);

    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
    const uploads = await scope.owner.call("POST", `/recordings/${recordingId}/uploads`, {
      trackNumber: 0,
      chunks: [
        {
          chunkNumber: 0,
          byteLength: bytes.byteLength,
          sha256: sha(bytes),
          startMilliseconds: 0,
          durationMilliseconds: 2_000,
        },
      ],
    });
    scope.objects.set(new URL(uploads.body.uploads[0].url).pathname.slice(1), bytes);
    await scope.owner.call("POST", `/recordings/${recordingId}/chunks/complete`, {
      trackNumber: 0,
      chunkNumbers: [0],
    });
    const finalized = await scope.owner.call("POST", `/recordings/${recordingId}/finalize`, {
      tracks: [{ trackNumber: 0, chunkCount: 1 }],
    });
    expect(finalized.status).toBe(200);
    expect(finalized.body.transcript).toMatchObject({
      providerId: "openai",
      model: "gpt-transcribe",
      state: "queued",
    });
    expect(selected.at(-1)).toMatchObject({ preferredProvider: "openai", fallbackEnabled: false });
    expect(scope.started.at(-1)).toMatchObject({ kind: "transcript", recordingId });
    // A dictation never reaches webhooks or automations.
    const [{ count }] = await shared.admin`
      select count(*)::int as count from recording_events where recording_id = ${recordingId}`;
    expect(count).toBe(0);
    const [{ credit_attribution: attribution }] = await shared.admin`
      select credit_attribution from recording_transcript_versions where recording_id = ${recordingId}`;
    expect(attribution).toMatchObject({ kind: "human" });

    // Voice input turned off: no new dictations.
    await shared.admin`
      update workspaces set settings = settings || '{"voiceInput":{"enabled":false}}'::jsonb
      where id = ${scope.workspaceId}`;
    const refused = await scope.owner.call("POST", "/recordings", {
      recordingId: crypto.randomUUID(),
      purpose: "dictation",
      tracks: mic,
    });
    expect(refused).toMatchObject({
      status: 403,
      body: { error: { details: { code: "policy_blocked" } } },
    });
  });

  test("the workspace's meeting language, unless a recording names one or asks to detect", async () => {
    const scope = await fixture();
    expect((await scope.owner.call("GET", "/recording-models")).body.language).toBeNull();
    await shared.admin`
      update workspaces set settings = settings || '{"recordings":{"language":"no"}}'::jsonb
      where id = ${scope.workspaceId}`;
    // Recorders show it before the meeting starts.
    expect((await scope.owner.call("GET", "/recording-models")).body.language).toBe("no");
    const create = async (transcription?: { language?: string | null }) => {
      const recordingId = crypto.randomUUID();
      const created = await scope.owner.call("POST", "/recordings", {
        recordingId,
        tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
        ...(transcription ? { transcription } : {}),
      });
      expect(created.status).toBe(201);
      return created.body as { id: string; transcription: { language?: string | null } };
    };
    // None named: the workspace's, settled at the start for the live transcript.
    expect((await create()).transcription.language).toBe("no");
    expect((await create({})).transcription.language).toBe("no");
    expect((await create({ language: "en" })).transcription.language).toBe("en");
    // Null detects it, even though the workspace names one.
    expect((await create({ language: null })).transcription.language).toBeUndefined();
    const settings = { language: "no" };
    expect(meetingLanguage(null, settings)).toBeUndefined();
    expect(meetingLanguage(undefined, settings)).toBe("no");
    expect(meetingLanguage("en", settings)).toBe("en");
    expect(meetingLanguage(undefined, {})).toBeUndefined();
  });

  test("remembering a voice needs recognition on and the person's agreement", async () => {
    const scope = await fixture();
    const outsider = await scope.owner.call("POST", "/recording-people", { displayName: "Ingrid" });
    const member = await scope.owner.call("POST", "/recording-people", {
      displayName: "Owner",
      memberSubjectId: scope.owner.subjectId,
    });
    const voice = (id: string) => `/recording-people/${id}/voice`;
    expect(
      await scope.owner.call("PUT", voice(outsider.body.id), { consent: "attested" }),
    ).toMatchObject({
      status: 409,
      body: { error: { details: { code: "voice_recognition_off" } } },
    });

    expect(
      (await scope.admin("PATCH", "/settings", { recordings: { voiceprints: true } })).status,
    ).toBe(200);
    expect(
      await scope.owner.call("PUT", voice(outsider.body.id), { consent: "attested" }),
    ).toMatchObject({ status: 200, body: { voice: { consent: "attested", learned: false } } });
    expect((await scope.other.call("PUT", voice(member.body.id), { consent: "self" })).status).toBe(
      403,
    );
    expect(await scope.owner.call("PUT", voice(member.body.id), { consent: "self" })).toMatchObject(
      { status: 200, body: { voice: { consent: "self" } } },
    );
    expect((await scope.other.call("DELETE", voice(member.body.id))).status).toBe(403);
    expect(await scope.other.call("DELETE", voice(outsider.body.id))).toMatchObject({
      status: 200,
      body: { voice: null },
    });

    // Turning recognition off withdraws every agreement.
    expect((await scope.admin("PATCH", "/settings", { recordings: {} })).status).toBe(200);
    const people = (await scope.owner.call("GET", "/recording-people")).body.people;
    expect(people.map((person: { voice: unknown }) => person.voice)).toEqual([null, null]);
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
    expect(
      models.body.models.find((model: { model: string }) => model.model === "scribe_v2"),
    ).toMatchObject({
      providerId: "elevenlabs",
      model: "scribe_v2",
      available: false,
      funding: "workspace_key",
    });
    // The deployment's voice input models return only text, so they serve
    // dictation and are not offered for meetings.
    expect(
      models.body.models.find((model: { providerId: string }) => model.providerId === "openai"),
    ).toBeUndefined();
    expect(
      (
        await scope.owner.call("POST", "/recordings", {
          recordingId: crypto.randomUUID(),
          tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
          transcription: { providerId: "openai", model: "gpt-transcribe" },
        })
      ).status,
    ).toBe(400);
    expect(models.body).toMatchObject({ dictationDefault: null, pinned: false });
    expect(
      models.body.models.find((model: { model: string }) => model.model === "scribe_v2_realtime")
        .capabilities,
    ).toMatchObject({ batch: false, live: true });
    // A live-only model cannot make a transcript.
    expect(
      (
        await scope.owner.call("POST", "/recordings", {
          recordingId: crypto.randomUUID(),
          tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
          transcription: { providerId: "elevenlabs", model: "scribe_v2_realtime" },
        })
      ).status,
    ).toBe(400);
  });

  test("an app's own user with computer audio is named by the app; Opengeni's name stays first", async () => {
    const scope = await fixture();
    const tracks = [
      { trackNumber: 0, source: "microphone", mimeType: "audio/webm" },
      { trackNumber: 1, source: "system", mimeType: "audio/webm" },
    ];
    const peopleFor = async (subjectId: string) =>
      (
        (await scope.owner.call("GET", "/recording-people")).body.people as {
          displayName: string;
          memberSubjectId: string | null;
        }[]
      ).filter((person) => person.memberSubjectId === subjectId);
    // A microphone alone may hear a whole room, so it names no one.
    expect(
      (
        await scope.other.call("POST", "/recordings", {
          recordingId: crypto.randomUUID(),
          tracks: [tracks[0]],
          ownerName: "Per Hansen",
        })
      ).status,
    ).toBe(201);
    expect(await peopleFor(scope.other.subjectId)).toEqual([]);
    // Beside computer audio the microphone is theirs: Opengeni has no name
    // for the app's user, so the app's is used.
    expect(
      (
        await scope.owner.call("POST", "/recordings", {
          recordingId: crypto.randomUUID(),
          tracks,
          ownerName: "  Ola Nordmann ",
        })
      ).status,
    ).toBe(201);
    expect(await peopleFor(scope.owner.subjectId)).toMatchObject([
      { displayName: "Ola Nordmann", memberSubjectId: scope.owner.subjectId },
    ]);
    // Once they are in the directory, a later name changes nothing there.
    expect(
      (
        await scope.owner.call("POST", "/recordings", {
          recordingId: crypto.randomUUID(),
          tracks,
          ownerName: "Someone Else",
        })
      ).status,
    ).toBe(201);
    expect((await peopleFor(scope.owner.subjectId)).map((person) => person.displayName)).toEqual([
      "Ola Nordmann",
    ]);
    expect(
      (
        await scope.owner.call("POST", "/recordings", {
          recordingId: crypto.randomUUID(),
          tracks,
          ownerName: "x".repeat(201),
        })
      ).status,
    ).toBe(400);
  });

  test("a deployment's own Azure Speech account is available to every workspace and is the default", async () => {
    const scope = await fixture({
      settings: {
        recordingAzureSpeechEndpoint: "https://speech.example.cognitiveservices.azure.com",
        recordingAzureSpeechApiKey: "deployment-key",
      },
    });
    const models = await scope.owner.call("GET", "/recording-models");
    expect(models.body.default).toEqual({ providerId: "azure-speech", model: "MAI-Transcribe-2" });
    expect(
      models.body.models.find(
        (model: { providerId: string }) => model.providerId === "azure-speech",
      ),
    ).toMatchObject({
      providerName: "Azure Speech",
      model: "MAI-Transcribe-2",
      available: true,
      // The deployment covers it and charges no credits, so it costs this
      // workspace nothing per hour.
      usdPerHour: null,
      capabilities: { batch: true, live: false, diarization: false, wordTimestamps: true },
    });
    // Without a workspace key, ElevenLabs stays unavailable; on its own key
    // the workspace pays the list price.
    const scribe = models.body.models.find(
      (model: { model: string }) => model.model === "scribe_v2",
    );
    expect(scribe.available).toBe(false);
    expect(scribe.usdPerHour).toBeGreaterThan(0);
  });

  test("a deployment's model shows a price where its use is charged in credits", async () => {
    const settings = { recordingWordAlignment: true } as const;
    const free = await fixture({ settings });
    const charged = await fixture({ settings: { ...settings, usageLimitsMode: "managed" } });
    const priceOf = async (scope: Awaited<ReturnType<typeof fixture>>) =>
      (await scope.owner.call("GET", "/recording-models")).body.models.find(
        (model: { providerId: string }) => model.providerId === "openai",
      ).usdPerHour;
    expect(await priceOf(free)).toBeNull();
    expect(await priceOf(charged)).toBeGreaterThan(0);
  });

  test("a deployment that aligns words itself offers text-only models for meetings", async () => {
    const scope = await fixture({ settings: { recordingWordAlignment: true } });
    const models = await scope.owner.call("GET", "/recording-models");
    expect(
      models.body.models.find((model: { providerId: string }) => model.providerId === "openai"),
    ).toMatchObject({ model: "gpt-transcribe", capabilities: { wordTimestamps: false } });
    // With no ElevenLabs key here, meetings default to the model this
    // workspace can use rather than one that would fail.
    expect(models.body.default).toEqual({ providerId: "openai", model: "gpt-transcribe" });
    expect(
      (
        await scope.owner.call("POST", "/recordings", {
          recordingId: crypto.randomUUID(),
          tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
          transcription: { providerId: "openai", model: "gpt-transcribe" },
        })
      ).status,
    ).toBe(201);
  });

  test("a pinned deployment offers its one model for everything and refuses any other", async () => {
    const scope = await fixture({
      settings: {
        recordingAzureSpeechEndpoint: "https://speech.example.cognitiveservices.azure.com",
        recordingAzureSpeechApiKey: "deployment-key",
        speechToTextPinned: "azure-speech/MAI-Transcribe-2",
      },
    });
    const pin = { providerId: "azure-speech", model: "MAI-Transcribe-2" };
    const models = await scope.owner.call("GET", "/recording-models");
    expect(models.body).toMatchObject({ default: pin, dictationDefault: pin, pinned: true });
    expect(
      models.body.models.map((model: { providerId: string; model: string }) => ({
        providerId: model.providerId,
        model: model.model,
      })),
    ).toEqual([pin]);
    const create = async (transcription: { providerId: string; model: string }) =>
      (
        await scope.owner.call("POST", "/recordings", {
          recordingId: crypto.randomUUID(),
          tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
          transcription,
        })
      ).status;
    expect(await create({ providerId: "elevenlabs", model: "scribe_v2" })).toBe(400);
    expect(await create(pin)).toBe(201);
  });

  test("a pinned deployment streams the live preview to the Azure OpenAI deployment its operator names", async () => {
    const minted: { url: string; authorization: string | null }[] = [];
    const scope = await fixture({
      settings: {
        recordingAzureSpeechEndpoint: "https://speech.example.cognitiveservices.azure.com",
        recordingAzureSpeechApiKey: "deployment-key",
        speechToTextPinned: "azure-speech/MAI-Transcribe-2",
        recordingLiveTranscription: "azure-openai/gpt-4o-transcribe",
        voiceInputProviderOrder: "azure-openai",
        voiceInputAzureEndpoint: "https://ai.example.cognitiveservices.azure.com",
        voiceInputAzureDeployment: "gpt-4o-transcribe",
        azureTenantId: "tenant",
        azureClientId: "client",
        azureClientSecret: "secret",
      },
      speechFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.includes("/oauth2/")) {
          return Response.json({ access_token: "entra", expires_in: 3_600 });
        }
        minted.push({ url: request.url, authorization: request.headers.get("authorization") });
        return Response.json({
          value: "ek_live",
          expires_at: Math.floor(Date.now() / 1_000) + 600,
        });
      }) as typeof fetch,
    });
    const models = await scope.owner.call("GET", "/recording-models");
    // Meetings still use only the pin; the live model is offered for the preview only.
    expect(
      models.body.models.map(
        (model: {
          providerId: string;
          model: string;
          capabilities: { batch: boolean; live: boolean };
        }) => ({
          providerId: model.providerId,
          model: model.model,
          batch: model.capabilities.batch,
          live: model.capabilities.live,
        }),
      ),
    ).toEqual([
      { providerId: "azure-speech", model: "MAI-Transcribe-2", batch: true, live: false },
      { providerId: "azure-openai", model: "gpt-4o-transcribe", batch: false, live: true },
    ]);
    expect(models.body).toMatchObject({
      default: { providerId: "azure-speech", model: "MAI-Transcribe-2" },
      pinned: true,
    });
    const recordingId = crypto.randomUUID();
    await scope.owner.call("POST", "/recordings", {
      recordingId,
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    });
    // Deployment-funded, so no workspace key is needed.
    const granted = await scope.owner.call("POST", `/recordings/${recordingId}/live-session`, {
      trackNumber: 0,
    });
    expect(granted).toMatchObject({
      status: 201,
      body: {
        providerId: "azure-openai",
        model: "gpt-4o-transcribe",
        protocol: "openai.realtime",
        url: "wss://ai.example.cognitiveservices.azure.com/openai/v1/realtime?intent=transcription",
        token: "ek_live",
        webrtcUrl: "https://ai.example.cognitiveservices.azure.com/openai/v1/realtime/calls",
        audio: { encoding: "pcm_s16le", sampleRate: 24_000 },
      },
    });
    expect(minted).toEqual([
      {
        url: "https://ai.example.cognitiveservices.azure.com/openai/v1/realtime/client_secrets",
        authorization: "Bearer entra",
      },
    ]);
    // Audio still never goes anywhere else.
    expect(
      (
        await scope.owner.call("POST", `/recordings/${recordingId}/live-session`, {
          trackNumber: 0,
          providerId: "elevenlabs",
        })
      ).status,
    ).toBe(400);
  });

  test("the live preview: a single-use grant for the recorder, text for everyone who can see it", async () => {
    const tokenRequests: { url: string; key: string | null }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      tokenRequests.push({ url: request.url, key: request.headers.get("xi-api-key") });
      return Response.json({ token: "sutkn_live" });
    }) as typeof fetch;
    let scope: Awaited<ReturnType<typeof fixture>>;
    try {
      scope = await fixture();
    } finally {
      globalThis.fetch = realFetch;
    }
    const recordingId = crypto.randomUUID();
    await scope.owner.call("POST", "/recordings", {
      recordingId,
      visibility: "workspace",
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    });
    const noKey = await scope.owner.call("POST", `/recordings/${recordingId}/live-session`, {
      trackNumber: 0,
    });
    expect(noKey).toMatchObject({
      status: 409,
      body: { error: { details: { code: "credential_unavailable" } } },
    });
    await createConnection(db.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      subjectId: null,
      providerDomain: "api.elevenlabs.io",
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify({ apiKey: "workspace-eleven-key" }),
      ),
      metadata: { credentialRole: "elevenlabs", credentialLabel: "ElevenLabs" },
      createdBySubjectId: scope.owner.subjectId,
    });
    expect(
      (
        await scope.other.call("POST", `/recordings/${recordingId}/live-session`, {
          trackNumber: 0,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await scope.owner.call("POST", `/recordings/${recordingId}/live-session`, {
          trackNumber: 0,
          model: "scribe_v2",
        })
      ).status,
    ).toBe(400);
    const granted = await scope.owner.call("POST", `/recordings/${recordingId}/live-session`, {
      trackNumber: 0,
    });
    expect(granted.status).toBe(201);
    expect(granted.body).toMatchObject({
      providerId: "elevenlabs",
      model: "scribe_v2_realtime",
      protocol: "elevenlabs.scribe_realtime",
      audio: { encoding: "pcm_s16le", sampleRate: 16_000 },
    });
    expect(granted.body.url).toContain("token=sutkn_live");
    expect(JSON.stringify(granted.body)).not.toContain("workspace-eleven-key");
    expect(tokenRequests).toEqual([
      {
        url: "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
        key: "workspace-eleven-key",
      },
    ]);

    const saved = await scope.owner.call("POST", `/recordings/${recordingId}/live-segments`, {
      trackNumber: 0,
      streamedMilliseconds: 1_800_000,
      segments: [{ segmentNumber: 0, startMilliseconds: 0, endMilliseconds: 1_200, text: "Hei." }],
    });
    expect(saved).toMatchObject({ status: 200, body: { saved: 1, ended: false } });
    expect(
      (
        await scope.other.call("POST", `/recordings/${recordingId}/live-segments`, {
          trackNumber: 0,
          streamedMilliseconds: 0,
          segments: [],
        })
      ).status,
    ).toBe(403);
    const read = await scope.other.call("GET", `/recordings/${recordingId}/live-segments?after=0`);
    expect(read.body).toMatchObject({ ended: false, segments: [{ trackNumber: 0, text: "Hei." }] });
    expect(
      (
        await scope.other.call(
          "GET",
          `/recordings/${recordingId}/live-segments?after=${read.body.after}`,
        )
      ).body.segments,
    ).toEqual([]);
    const recording = await scope.other.call("GET", `/recordings/${recordingId}`);
    expect(recording.body.tracks[0].live).toEqual({
      providerId: "elevenlabs",
      model: "scribe_v2_realtime",
      streamedMilliseconds: 1_800_000,
      costUsd: 0.195,
    });
  });
});
