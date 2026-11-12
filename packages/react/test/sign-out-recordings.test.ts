import { afterEach, describe, expect, test } from "bun:test";

import {
  createMemoryRecordingChunkStore,
  type RecordingChunkStore,
  type StoredRecording,
} from "@opengeni/sdk/recordings";
import {
  prepareRecordingsForSignOut,
  recordingOwnerKey,
  registerLiveRecordingCapture,
  setSignOutRecordingsPrompt,
  type SignOutRecordingsChoice,
} from "../src/meetings/sign-out-recordings";

// CASA 6.6.1: recordings not uploaded yet don't outlive the person's sign-out
// on this device, unless they choose to stay signed in until they upload.

function recording(recordingId: string, ownerId?: string): StoredRecording {
  return {
    workspaceId: "workspace",
    recordingId,
    ...(ownerId ? { ownerId } : {}),
    create: {
      recordingId,
      startedAt: "2026-11-10T08:00:00.000Z",
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm" }],
    },
    created: true,
    phase: "stopped",
    endedAt: "2026-11-10T08:30:00.000Z",
    chunkCounts: { 0: 1 },
    updatedAt: 0,
  };
}

async function storeWith(...recordings: StoredRecording[]): Promise<RecordingChunkStore> {
  const store = createMemoryRecordingChunkStore();
  for (const each of recordings) {
    await store.putRecording(each);
    await store.putChunk({
      recordingId: each.recordingId,
      trackNumber: 0,
      chunkNumber: 0,
      bytes: new Uint8Array([1, 2, 3]),
      sha256: "00",
      startMilliseconds: 0,
      durationMilliseconds: 5_000,
    });
  }
  return store;
}

const ids = async (store: RecordingChunkStore) =>
  (await store.listRecordings()).map((each) => each.recordingId).sort();

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function answer(choice: SignOutRecordingsChoice): { asked: number[] } {
  const asked: number[] = [];
  cleanups.push(
    setSignOutRecordingsPrompt(async ({ recordings }) => {
      asked.push(recordings);
      return choice;
    }),
  );
  return { asked };
}

describe("prepareRecordingsForSignOut", () => {
  test("with nothing left to upload, signs out without asking", async () => {
    const { asked } = answer("wait");
    const store = await storeWith(recording("other", "b@example.com"));
    expect(await prepareRecordingsForSignOut("a@example.com", { store })).toBe(true);
    expect(asked).toEqual([]);
    expect(await ids(store)).toEqual(["other"]);
  });

  test("waiting keeps the person signed in and their recordings", async () => {
    const { asked } = answer("wait");
    const store = await storeWith(recording("mine", "a@example.com"));
    expect(await prepareRecordingsForSignOut("a@example.com", { store })).toBe(false);
    expect(asked).toEqual([1]);
    expect(await ids(store)).toEqual(["mine"]);
  });

  test("discarding removes the person's recordings and their audio, and nobody else's", async () => {
    const { asked } = answer("discard");
    const store = await storeWith(
      recording("mine", "a@example.com"),
      recording("untagged"),
      recording("theirs", "b@example.com"),
    );
    expect(await prepareRecordingsForSignOut("a@example.com", { store })).toBe(true);
    expect(asked).toEqual([2]);
    expect(await ids(store)).toEqual(["theirs"]);
    expect(await store.listChunks("mine")).toEqual([]);
    expect(await store.readChunk("untagged", 0, 0)).toBeNull();
    expect(await store.listChunks("theirs")).toHaveLength(1);
  });

  test("everyone signing out removes every recording on the device", async () => {
    answer("discard");
    const store = await storeWith(recording("mine", "a@example.com"), recording("theirs", "b@x"));
    expect(await prepareRecordingsForSignOut(null, { store })).toBe(true);
    expect(await ids(store)).toEqual([]);
  });

  test("where nobody can be asked, discards without asking", async () => {
    const { asked } = answer("wait");
    const store = await storeWith(recording("mine", "a@example.com"));
    expect(await prepareRecordingsForSignOut("a@example.com", { store, ask: false })).toBe(true);
    expect(asked).toEqual([]);
    expect(await ids(store)).toEqual([]);
  });

  test("with no prompt shown on the page, discards", async () => {
    const store = await storeWith(recording("mine"));
    expect(await prepareRecordingsForSignOut("a@example.com", { store })).toBe(true);
    expect(await ids(store)).toEqual([]);
  });

  test("a prompt passed in replaces the page's", async () => {
    const { asked } = answer("discard");
    const store = await storeWith(recording("mine"));
    const result = await prepareRecordingsForSignOut("a@example.com", {
      store,
      prompt: async () => "wait",
    });
    expect(result).toBe(false);
    expect(asked).toEqual([]);
  });

  test("discarding stops the person's capture in progress first, not someone else's", async () => {
    answer("discard");
    const stopped: string[] = [];
    cleanups.push(
      registerLiveRecordingCapture({
        ownerId: "a@example.com",
        discard: async () => void stopped.push("a"),
      }),
      registerLiveRecordingCapture({
        ownerId: "b@example.com",
        discard: async () => void stopped.push("b"),
      }),
    );
    const store = await storeWith(recording("mine", "a@example.com"));
    expect(await prepareRecordingsForSignOut("a@example.com", { store })).toBe(true);
    expect(stopped).toEqual(["a"]);
  });

  test("a store that fails to read never blocks signing out", async () => {
    const store = {
      ...createMemoryRecordingChunkStore(),
      listRecordings: async () => {
        throw new Error("blocked");
      },
    };
    expect(await prepareRecordingsForSignOut("a@example.com", { store })).toBe(true);
  });
});

test("recordingOwnerKey compares sign-in emails without case or spaces", () => {
  expect(recordingOwnerKey(" Ola@Example.COM ")).toBe("ola@example.com");
  expect(recordingOwnerKey("")).toBeNull();
  expect(recordingOwnerKey(null)).toBeNull();
});
