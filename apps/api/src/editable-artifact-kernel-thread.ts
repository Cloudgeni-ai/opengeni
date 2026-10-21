import { parentPort } from "node:worker_threads";
import type { ArtifactKernelRuntime } from "@opengeni/artifact-tool/runtime";
import type {
  ApplyAuthoritativeEditableArtifactKernelRequest,
  AuthoritativeEditableArtifactCompactionKernelResult,
  AuthoritativeEditableArtifactGenesisKernelPort,
  AuthoritativeEditableArtifactGenesisKernelResult,
  EditableArtifactKernelState,
  EditableArtifactSnapshotReplayPlan,
  IsolatedEditableArtifactSnapshotKernelPort,
} from "@opengeni/core";
import type { BoundedObjectReadPort } from "@opengeni/storage";
import {
  NativeEditableArtifactKernelAdapter,
  collectExact,
} from "./editable-artifact-native-kernel";

type VerifyInput = Parameters<
  IsolatedEditableArtifactSnapshotKernelPort["verifyAndReconstruct"]
>[0];
type GenesisInput = Parameters<
  AuthoritativeEditableArtifactGenesisKernelPort["createCanonicalEmptySnapshot"]
>[0];

/** Replay segments are collected by the I/O side and replayed in order here. */
export type EditableArtifactKernelThreadReplayPlan = Omit<
  EditableArtifactSnapshotReplayPlan,
  "segments"
> &
  Readonly<{
    segments: readonly (EditableArtifactSnapshotReplayPlan extends {
      segments: AsyncIterable<infer Segment>;
    }
      ? Segment
      : never)[];
  }>;

/**
 * Plain, structured-clone-safe work for the native kernel thread. The calling
 * thread performs all storage I/O; the kernel thread only runs native code.
 */
export type EditableArtifactKernelThreadOperation =
  | Readonly<{
      op: "apply";
      request: Pick<
        ApplyAuthoritativeEditableArtifactKernelRequest,
        "modality" | "state" | "intentBytes"
      > &
        Readonly<{
          intent: Readonly<{ commandBytes: Uint8Array }>;
          resolvedCausalBase?: unknown;
        }>;
      snapshotBytes: Uint8Array;
    }>
  | Readonly<{
      op: "query";
      state: EditableArtifactKernelState;
      queryBytes: Uint8Array;
      snapshotBytes: Uint8Array;
    }>
  | Readonly<{
      op: "genesis";
      input: Pick<GenesisInput, "scope" | "artifactId" | "modality">;
    }>
  | Readonly<{
      op: "compact";
      state: EditableArtifactKernelState;
      snapshotBytes: Uint8Array;
    }>
  | Readonly<{
      op: "verify";
      input: Omit<VerifyInput, "snapshotChunks" | "replayPlan" | "signal">;
      snapshotBytes: Uint8Array;
      replayPlan?: EditableArtifactKernelThreadReplayPlan;
    }>;

/** Snapshot results carry one canonical byte array instead of an iterable. */
export type EditableArtifactKernelThreadSnapshotResult<
  Result extends { canonicalChunks: AsyncIterable<Uint8Array> },
> = Omit<Result, "canonicalChunks"> & Readonly<{ canonicalBytes: Uint8Array }>;

export type EditableArtifactKernelThreadGenesisResult =
  EditableArtifactKernelThreadSnapshotResult<AuthoritativeEditableArtifactGenesisKernelResult>;
export type EditableArtifactKernelThreadCompactionResult =
  EditableArtifactKernelThreadSnapshotResult<AuthoritativeEditableArtifactCompactionKernelResult>;

export type EditableArtifactKernelThreadRequest = Readonly<{
  id: number;
  operation: EditableArtifactKernelThreadOperation;
}>;

export type EditableArtifactKernelThreadResponse =
  | Readonly<{ id: number; ok: true; result: unknown }>
  | Readonly<{ id: number; ok: false; error: Readonly<{ name: string; message: string }> }>;

/** Runs one operation against the native kernel. Exported for tests. */
export async function runEditableArtifactKernelThreadOperation(
  runtime: ArtifactKernelRuntime,
  operation: EditableArtifactKernelThreadOperation,
): Promise<unknown> {
  switch (operation.op) {
    case "apply": {
      const adapter = adapterFor(runtime, operation.request.state, operation.snapshotBytes);
      return await adapter.applyTransaction(
        operation.request as unknown as ApplyAuthoritativeEditableArtifactKernelRequest,
      );
    }
    case "query": {
      const adapter = adapterFor(runtime, operation.state, operation.snapshotBytes);
      return await adapter.query({ state: operation.state, queryBytes: operation.queryBytes });
    }
    case "genesis": {
      const adapter = new NativeEditableArtifactKernelAdapter(runtime, noObjects);
      return await withCanonicalBytes(await adapter.createCanonicalEmptySnapshot(operation.input));
    }
    case "compact": {
      const adapter = adapterFor(runtime, operation.state, operation.snapshotBytes);
      return await withCanonicalBytes(
        await adapter.createCanonicalSnapshot({ state: operation.state }),
      );
    }
    case "verify": {
      const adapter = new NativeEditableArtifactKernelAdapter(runtime, noObjects);
      const replayPlan = operation.replayPlan;
      return await adapter.verifyAndReconstruct({
        ...operation.input,
        snapshotChunks: iterate([operation.snapshotBytes]),
        ...(replayPlan
          ? {
              replayPlan: {
                ...replayPlan,
                segments: iterate(replayPlan.segments),
              } as unknown as EditableArtifactSnapshotReplayPlan,
            }
          : {}),
      });
    }
  }
}

/** Serves kernel operations on this worker thread until it is terminated. */
export function serveEditableArtifactKernelThread(
  loadRuntime: () => Promise<ArtifactKernelRuntime>,
): void {
  const port = parentPort;
  if (!port) throw new Error("Editable artifact kernel thread requires a parent port");
  const runtime = loadRuntime();
  // Surface a broken runtime on the first request rather than as an unhandled rejection.
  runtime.catch(() => undefined);
  port.on("message", (message: EditableArtifactKernelThreadRequest) => {
    void (async () => {
      let response: EditableArtifactKernelThreadResponse;
      try {
        const result = await runEditableArtifactKernelThreadOperation(
          await runtime,
          message.operation,
        );
        response = { id: message.id, ok: true, result };
      } catch (error) {
        response = {
          id: message.id,
          ok: false,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      port.postMessage(response);
    })();
  });
}

function adapterFor(
  runtime: ArtifactKernelRuntime,
  state: EditableArtifactKernelState,
  snapshotBytes: Uint8Array,
): NativeEditableArtifactKernelAdapter {
  const reference = state.snapshot?.blobReference;
  const objects: BoundedObjectReadPort = Object.freeze({
    async open(input: { opaqueReference: string }) {
      if (input.opaqueReference !== reference) {
        throw new Error("Kernel thread received bytes for a different snapshot");
      }
      return Object.freeze({
        byteSize: snapshotBytes.byteLength,
        contentType: undefined,
        chunks: () => iterate([snapshotBytes]),
        assertUnchanged: async () => undefined,
        close: async () => undefined,
      });
    },
  });
  return new NativeEditableArtifactKernelAdapter(runtime, objects);
}

const noObjects: BoundedObjectReadPort = Object.freeze({
  async open(): Promise<never> {
    throw new Error("Kernel thread operation does not read objects");
  },
});

async function withCanonicalBytes<Result extends { canonicalChunks: AsyncIterable<Uint8Array> }>(
  result: Result,
): Promise<EditableArtifactKernelThreadSnapshotResult<Result>> {
  const { canonicalChunks, ...rest } = result;
  const canonicalBytes = await collectExact(
    canonicalChunks,
    (result as unknown as { canonicalByteSize: number }).canonicalByteSize,
  );
  return { ...rest, canonicalBytes } as EditableArtifactKernelThreadSnapshotResult<Result>;
}

async function* iterate<Item>(items: readonly Item[]): AsyncIterable<Item> {
  for (const item of items) yield item;
}
