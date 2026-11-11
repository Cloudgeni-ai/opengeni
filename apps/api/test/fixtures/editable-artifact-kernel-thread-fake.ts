import type { ArtifactKernelRuntime } from "@opengeni/artifact-tool/runtime";
import { encodeEditableArtifactCausalFrontier } from "@opengeni/contracts/editable-artifact-causal-frontier";
import { serveEditableArtifactKernelThread } from "../../src/editable-artifact-kernel-thread";

// Kept in sync with editable-artifact-kernel-pool.test.ts.
const FAKE_KERNEL_STATE_HASH = `sha256:${"2".repeat(64)}`;
const FAKE_KERNEL_BUSY_MS = 300;

/** A synchronous stand-in for the native kernel that holds its thread busy. */
function fakeRuntime(): ArtifactKernelRuntime {
  const frontierBytes = encodeEditableArtifactCausalFrontier([]);
  return {
    kind: "native",
    target: "linux-x64-gnu",
    capabilities: {},
    buildIdentity: "native-kernel-thread-test",
    openCollaborationSession: (snapshot: Uint8Array) => {
      if (snapshot[0] === 0xff) throw new Error("fake kernel rejected the snapshot");
      return {
        authorTransaction() {
          throw new Error("unused");
        },
        applyCommitted() {
          throw new Error("unused");
        },
        query() {
          throw new Error("unused");
        },
        snapshot: () => {
          const until = Date.now() + FAKE_KERNEL_BUSY_MS;
          while (Date.now() < until) {
            // Deliberately synchronous, like a large native replay.
          }
          return snapshot.slice();
        },
        frontier: () => frontierBytes.slice(),
        stateHash: () => FAKE_KERNEL_STATE_HASH,
        revision: () => 7n,
        fork() {
          throw new Error("unused");
        },
        isClosed: () => false,
        dispose() {},
      };
    },
  } as unknown as ArtifactKernelRuntime;
}

serveEditableArtifactKernelThread(async () => fakeRuntime());
