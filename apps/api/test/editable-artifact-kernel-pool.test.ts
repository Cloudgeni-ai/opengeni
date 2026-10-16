import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactId,
  editableArtifactScope,
  editableArtifactSnapshotId,
  editableArtifactStateHash,
  type EditableArtifactKernelState,
} from "@opengeni/core";
import type { BoundedObjectReadPort } from "@opengeni/storage";
import { OffThreadEditableArtifactKernel } from "../src/editable-artifact-kernel-pool";

// Must match test/fixtures/editable-artifact-kernel-thread-fake.ts.
const STATE_HASH = editableArtifactStateHash(`sha256:${"2".repeat(64)}`);
const BUSY_MS = 300;
const THREAD_URL = new URL("./fixtures/editable-artifact-kernel-thread-fake.ts", import.meta.url);

const kernels: OffThreadEditableArtifactKernel[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.close();
});

function kernelFor(snapshots: Map<string, Uint8Array>, threads = 2) {
  const objects: BoundedObjectReadPort = {
    async open(input) {
      const bytes = snapshots.get(input.opaqueReference);
      if (!bytes) throw new Error("missing object");
      return {
        byteSize: bytes.byteLength,
        contentType: "application/vnd.opengeni.editable-artifact-snapshot",
        chunks: async function* () {
          yield bytes.slice();
        },
        assertUnchanged: async () => undefined,
        close: async () => undefined,
      };
    },
  };
  const kernel = new OffThreadEditableArtifactKernel({ objects, threadUrl: THREAD_URL, threads });
  kernels.push(kernel);
  return kernel;
}

function stateFor(reference: string, snapshotBytes: Uint8Array): EditableArtifactKernelState {
  const scope = editableArtifactScope({
    accountId: "10000000-0000-4000-8000-000000000001",
    workspaceId: "20000000-0000-4000-8000-000000000002",
  });
  const artifactId = editableArtifactId("1".repeat(32));
  const snapshotId = editableArtifactSnapshotId("2".repeat(32));
  return {
    modality: "spreadsheet",
    artifact: {
      scope,
      id: artifactId,
      modality: "spreadsheet",
      title: "Off-thread compaction",
      lifecycle: "active",
      authorizationRevision: 1,
      headSequence: 9,
      causalFrontier: editableArtifactCausalFrontier([]),
      stateHash: STATE_HASH,
      currentSnapshotId: snapshotId,
      createdAt: "2026-08-08T10:00:00.000Z",
      updatedAt: "2026-08-08T10:00:00.000Z",
    },
    snapshot: {
      scope,
      artifactId,
      modality: "spreadsheet",
      snapshotId,
      blobReference: reference,
      byteSize: snapshotBytes.byteLength,
      contentHash: editableArtifactContentHash(
        `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`,
      ),
      mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
      coveredHeadSequence: 9,
      coveredCausalFrontier: editableArtifactCausalFrontier([]),
      stateHash: STATE_HASH,
      modelSchemaVersion: 2,
      operationProtocolVersion: 2,
      kernelVersion: "native-kernel-thread-test",
      crdtStateVersion: 2,
      verifiedAt: "2026-08-08T10:00:00.000Z",
      publishedAt: "2026-08-08T10:00:00.000Z",
    },
    tailTransactionCount: 0,
    tailByteSize: 0,
    committedTransactionTail: [],
  } as unknown as EditableArtifactKernelState;
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk.slice());
  return Buffer.concat(parts);
}

describe("OffThreadEditableArtifactKernel", () => {
  test("runs native work off the calling thread and returns the same result", async () => {
    const snapshotBytes = new Uint8Array([3, 1, 4, 1, 5]);
    const kernel = kernelFor(new Map([["objects/a", snapshotBytes]]));
    // Warm a thread so the measurement covers only native work.
    await kernel.createCanonicalSnapshot({ state: stateFor("objects/a", snapshotBytes) });

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    const started = performance.now();
    const result = await kernel.createCanonicalSnapshot({
      state: stateFor("objects/a", snapshotBytes),
    });
    const elapsed = performance.now() - started;
    clearInterval(timer);

    expect(elapsed).toBeGreaterThanOrEqual(BUSY_MS - 5);
    // An in-process kernel would block every timer until the native call returned.
    expect(ticks).toBeGreaterThanOrEqual(5);
    expect((await collect(result.canonicalChunks)).equals(Buffer.from(snapshotBytes))).toBe(true);
    expect(result).toMatchObject({
      modality: "spreadsheet",
      coveredHeadSequence: 9,
      stateHash: STATE_HASH,
      canonicalByteSize: snapshotBytes.byteLength,
      kernelVersion: "native-kernel-thread-test",
      coveredCausalFrontier: [],
    });
  }, 30_000);

  test("runs independent operations in parallel up to the thread count", async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    const kernel = kernelFor(
      new Map([
        ["objects/a", a],
        ["objects/b", b],
      ]),
      2,
    );
    await Promise.all([
      kernel.createCanonicalSnapshot({ state: stateFor("objects/a", a) }),
      kernel.createCanonicalSnapshot({ state: stateFor("objects/b", b) }),
    ]);
    const started = performance.now();
    const [left, right] = await Promise.all([
      kernel.createCanonicalSnapshot({ state: stateFor("objects/a", a) }),
      kernel.createCanonicalSnapshot({ state: stateFor("objects/b", b) }),
    ]);
    expect(performance.now() - started).toBeLessThan(BUSY_MS * 2 - 50);
    expect((await collect(left.canonicalChunks)).equals(Buffer.from(a))).toBe(true);
    expect((await collect(right.canonicalChunks)).equals(Buffer.from(b))).toBe(true);
  }, 30_000);

  test("propagates kernel errors and keeps serving afterwards", async () => {
    const bad = new Uint8Array([0xff, 1]);
    const good = new Uint8Array([9, 9]);
    const kernel = kernelFor(
      new Map([
        ["objects/bad", bad],
        ["objects/good", good],
      ]),
      1,
    );
    await expect(
      kernel.createCanonicalSnapshot({ state: stateFor("objects/bad", bad) }),
    ).rejects.toThrow("fake kernel rejected the snapshot");
    const result = await kernel.createCanonicalSnapshot({ state: stateFor("objects/good", good) });
    expect((await collect(result.canonicalChunks)).equals(Buffer.from(good))).toBe(true);
  }, 30_000);

  test("rejects a tampered snapshot before replay", async () => {
    const snapshotBytes = new Uint8Array([3, 1, 4]);
    const kernel = kernelFor(new Map([["objects/a", new Uint8Array([3, 1, 5])]]));
    await expect(
      kernel.createCanonicalSnapshot({ state: stateFor("objects/a", snapshotBytes) }),
    ).rejects.toThrow("Snapshot content hash mismatch");
  }, 30_000);

  test("drops queued work when its caller cancels", async () => {
    const a = new Uint8Array([1, 2, 3]);
    const kernel = kernelFor(new Map([["objects/a", a]]), 1);
    const running = kernel.createCanonicalSnapshot({ state: stateFor("objects/a", a) });
    const controller = new AbortController();
    const queued = kernel.createCanonicalSnapshot({
      state: stateFor("objects/a", a),
      signal: controller.signal,
    });
    await Bun.sleep(20);
    controller.abort();
    await expect(queued).rejects.toThrow("cancelled");
    await running;
  }, 30_000);
});
