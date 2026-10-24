import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  browserRecordingActionLogObjectKey,
  browserRecordingBundleObjectKey,
  browserRecordingVideoObjectKey,
  createDb,
  findBrowserRecording,
  getBrowserRecordingVideo,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createBrowserRecordingActivities } from "../src/activities/browser-recordings";
import type { ControlActivityServices } from "../src/activities/types";
import { ffmpegPath, hasFfmpeg } from "./recording-audio-fixtures";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("browser-recordings");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

const withDbAndFfmpeg = hasFfmpeg ? test : test.skip;

function memoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    storage: {
      getObjectBytes: async (key: string) => objects.get(key) ?? null,
      putObject: async (args: { key: string; contentType: string; body: Uint8Array }) => {
        objects.set(args.key, { bytes: args.body, contentType: args.contentType });
      },
      deleteObject: async (key: string) => {
        objects.delete(key);
      },
    },
  };
}

function jpeg(color: string): Uint8Array {
  const run = spawnSync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=320x200`,
    "-frames:v",
    "1",
    "-f",
    "mjpeg",
    "pipe:1",
  ]);
  expect(run.status).toBe(0);
  return new Uint8Array(run.stdout);
}

function bundle(frames: { t: number; data: Uint8Array }[], durationMs: number): Uint8Array {
  let offset = 0;
  const index = frames.map((frame) => {
    const entry = { t: frame.t, offset, length: frame.data.byteLength, targetId: "tab" };
    offset += frame.data.byteLength;
    return entry;
  });
  const header = JSON.stringify({
    version: 1,
    recordingId: "00000000-0000-4000-8000-000000000001",
    startedAt: "2026-10-24T08:00:00.000Z",
    durationMs,
    mediaType: "image/jpeg",
    frames: index,
    actions: [{ t: 500, kind: "action", targetId: "tab", action: { type: "click" } }],
  });
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(`OGREC1\n${header}\n`),
      ...frames.map((frame) => Buffer.from(frame.data)),
    ]),
  );
}

async function scope() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "browser-recordings",
    accountExternalId: suffix,
    accountName: "Browser recordings",
    workspaceExternalSource: "browser-recordings",
    workspaceExternalId: suffix,
    workspaceName: "Browser recordings",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

function activities(storage: ReturnType<typeof memoryStorage>) {
  const services = async () =>
    ({
      db: client!.db,
      objectStorage: storage.storage,
      settings: { voiceInputFfmpegPath: ffmpegPath },
    }) as unknown as ControlActivityServices;
  return createBrowserRecordingActivities(services, {
    heartbeat: () => undefined,
    cancellationSignal: () => undefined,
  });
}

/** A bundle uploaded where the browser host puts it, and the workflow's input. */
async function uploaded(storage: ReturnType<typeof memoryStorage>, bytes: Uint8Array) {
  const owner = await scope();
  const recordingId = crypto.randomUUID();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const bundleKey = browserRecordingBundleObjectKey({ ...owner, recordingId, sha256 });
  storage.objects.set(bundleKey, { bytes, contentType: "application/octet-stream" });
  return {
    owner,
    bundleKey,
    input: {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      recordingId,
      ownerSubjectId: owner.subjectId,
      visibility: "private" as const,
      startedAt: "2026-10-24T08:00:00.000Z",
      durationMilliseconds: 3_000,
      bundle: { byteLength: bytes.byteLength, sha256 },
    },
  };
}

describe("browser recording activities", () => {
  withDbAndFfmpeg("make the video and action log, then drop the bundle", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const run = activities(storage);
    const { owner, bundleKey, input } = await uploaded(
      storage,
      bundle(
        [
          { t: 0, data: jpeg("red") },
          { t: 1_500, data: jpeg("blue") },
        ],
        3_000,
      ),
    );
    await run.createBrowserRecordingFromBundle(input);
    await run.createBrowserRecordingFromBundle(input);
    expect(await run.encodeBrowserRecordingVideo(input)).toEqual({ outcome: "complete" });

    const actor = { workspaceId: owner.workspaceId, subjectId: owner.subjectId };
    const videoKey = browserRecordingVideoObjectKey({ ...actor, recordingId: input.recordingId });
    const video = await getBrowserRecordingVideo(client.db, {
      ...actor,
      recordingId: input.recordingId,
    });
    const stored = storage.objects.get(videoKey);
    expect(stored?.contentType).toBe("video/mp4");
    expect(video).toMatchObject({
      objectKey: videoKey,
      bytes: stored!.bytes.byteLength,
      sha256: createHash("sha256").update(stored!.bytes).digest("hex"),
      width: 320,
      height: 200,
      frameCount: 2,
      durationMilliseconds: 3_000,
    });
    const log = storage.objects.get(
      browserRecordingActionLogObjectKey({ ...actor, recordingId: input.recordingId }),
    );
    expect(JSON.parse(new TextDecoder().decode(log!.bytes))).toMatchObject({
      durationMs: 3_000,
      pageChanges: [0, 1_500],
    });
    expect(storage.objects.has(bundleKey)).toBe(false);
    // Running again finds the video made.
    expect(await run.encodeBrowserRecordingVideo(input)).toEqual({ outcome: "skipped" });
  });

  withDbAndFfmpeg("a bundle with no frames fails for good, keeping the reason", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const run = activities(storage);
    const { owner, input } = await uploaded(storage, bundle([], 3_000));
    await run.createBrowserRecordingFromBundle(input);
    const failure = await run.encodeBrowserRecordingVideo(input).catch((error: unknown) => error);
    expect(failure).toMatchObject({ type: "no_frames", nonRetryable: true });
    await run.failBrowserRecording({
      ...input,
      errorCode: "no_frames",
      errorMessage: (failure as Error).message,
    });
    const found = await findBrowserRecording(client.db, {
      workspaceId: owner.workspaceId,
      subjectId: owner.subjectId,
      recordingId: input.recordingId,
    });
    expect(found?.recording).toMatchObject({ state: "failed", errorCode: "no_frames" });
    expect(found?.errorMessage).toBe(
      "the recording captured no frames; the page may not have been visible",
    );
  });

  test("a bundle that is gone or altered fails for good", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const run = activities(storage);
    const gone = await uploaded(storage, Uint8Array.from([1, 2, 3]));
    await run.createBrowserRecordingFromBundle(gone.input);
    storage.objects.delete(gone.bundleKey);
    await expect(run.encodeBrowserRecordingVideo(gone.input)).rejects.toMatchObject({
      type: "bundle_missing",
      nonRetryable: true,
    });
    const altered = await uploaded(storage, Uint8Array.from([4, 5, 6]));
    await run.createBrowserRecordingFromBundle(altered.input);
    storage.objects.set(altered.bundleKey, {
      bytes: Uint8Array.from([7]),
      contentType: "application/octet-stream",
    });
    await expect(run.encodeBrowserRecordingVideo(altered.input)).rejects.toMatchObject({
      type: "bundle_mismatch",
      nonRetryable: true,
    });
  });
});
