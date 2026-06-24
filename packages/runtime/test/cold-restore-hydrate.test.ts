// sandbox-file-persistence: the cold-restore archive+hydrate contract.
//
// When a warm resume-by-id reports the box GONE (provider NotFound),
// establishSandboxSessionFromEnvelope must:
//   (1) create a FRESH box from the manifest — NEVER create({ snapshot }) (that
//       throws assertCoreSnapshotUnsupported on Modal); and
//   (2) if the lease envelope carries a persisted /workspace archive at
//       sessionState.workspaceArchive, replay it via session.hydrateWorkspace(bytes)
//       on the freshly-created session so /workspace is restored.
//
// The modal SDK client (`ModalSandboxClient`) is mock.module-replaced with a
// Modal-shaped fake: resume() throws NotFound; create() ASSERTS it is never handed
// a `snapshot` arg (mirroring assertCoreSnapshotUnsupported); the created session
// records hydrateWorkspace calls. This drives the REAL
// establishSandboxSessionFromEnvelope (which builds its client from the registry)
// end to end without a live provider.

import { afterAll, describe, expect, mock, test } from "bun:test";

// Mock the modal SDK BEFORE importing the runtime (so the modal provider's
// `new ModalSandboxClient(...)` constructs our fake).
const hydrateCalls: Uint8Array[] = [];
const createArgs: Array<{ manifest?: unknown; snapshot?: unknown }> = [];

class FakeModalSandboxClient {
  backendId = "modal";
  constructor(public options: unknown) {}
  async deserializeSessionState(state: Record<string, unknown>) {
    return { ...state };
  }
  async resume() {
    throw new Error("Modal sandbox sb-old not found (has been terminated)");
  }
  async create(args: { manifest?: unknown; snapshot?: unknown }) {
    createArgs.push(args);
    if (args && "snapshot" in args && args.snapshot !== undefined) {
      throw new Error("assertCoreSnapshotUnsupported: ModalSandboxClient.create({ snapshot }) is unsupported");
    }
    return {
      state: { sandboxId: "sb-fresh" },
      async hydrateWorkspace(data: Uint8Array) {
        hydrateCalls.push(data);
      },
    };
  }
}

const realModal = await import("@openai/agents-extensions/sandbox/modal");
mock.module("@openai/agents-extensions/sandbox/modal", () => ({
  ...realModal,
  ModalSandboxClient: FakeModalSandboxClient,
}));

const {
  establishSandboxSessionFromEnvelope,
  readWorkspaceArchiveFromEnvelopeSessionState,
  decodeModalSnapshotId,
} = await import("@opengeni/runtime");
const { testSettings } = await import("@opengeni/testing");

afterAll(() => {
  mock.restore();
});

const SNAPSHOT_REF = 'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-snap-abc","workspace_persistence":"snapshot_filesystem"}';
const SNAPSHOT_BYTES = new TextEncoder().encode(SNAPSHOT_REF);
const SNAPSHOT_B64 = Buffer.from(SNAPSHOT_BYTES).toString("base64");

function envelopeWithArchive(archiveB64: string | undefined) {
  const sessionState: Record<string, unknown> = {
    providerState: { sandboxId: "sb-old", appName: "app", imageTag: "tag" },
    manifest: { root: "/workspace", environment: {} },
    workspaceReady: true,
  };
  if (archiveB64 !== undefined) {
    sessionState.workspaceArchive = archiveB64;
  }
  return { backendId: "modal", sessionState };
}

function modalSettings() {
  return testSettings({
    sandboxBackend: "modal",
    modalAppName: "app",
    modalTokenId: "tok",
    modalTokenSecret: "sec",
  });
}

describe("cold-restore archive+hydrate (sandbox-file-persistence)", () => {
  test("readWorkspaceArchiveFromEnvelopeSessionState round-trips base64 → exact bytes", () => {
    const out = readWorkspaceArchiveFromEnvelopeSessionState({ workspaceArchive: SNAPSHOT_B64 });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(out!)).toBe(SNAPSHOT_REF);
  });

  test("readWorkspaceArchiveFromEnvelopeSessionState returns undefined with no archive", () => {
    expect(readWorkspaceArchiveFromEnvelopeSessionState({})).toBeUndefined();
    expect(readWorkspaceArchiveFromEnvelopeSessionState({ workspaceArchive: "" })).toBeUndefined();
    expect(readWorkspaceArchiveFromEnvelopeSessionState(null)).toBeUndefined();
  });

  test("decodeModalSnapshotId extracts the image id from a fs-snapshot ref; undefined for tar", () => {
    expect(decodeModalSnapshotId(SNAPSHOT_BYTES)).toBe("im-snap-abc");
    expect(decodeModalSnapshotId(new TextEncoder().encode("PKtarbytes"))).toBeUndefined();
  });

  test("cold-restore creates a FRESH box (NO snapshot arg) and hydrates from the lease archive", async () => {
    hydrateCalls.length = 0;
    createArgs.length = 0;

    const established = await establishSandboxSessionFromEnvelope(
      modalSettings(),
      envelopeWithArchive(SNAPSHOT_B64),
      { sessionId: "sess-cold", environment: {} },
    );

    // (1) create() was called WITHOUT a `snapshot` arg (would throw on Modal).
    expect(createArgs).toHaveLength(1);
    expect("snapshot" in createArgs[0]!).toBe(false);
    expect(createArgs[0]!.manifest).toBeDefined();
    // (2) the persisted archive was replayed via hydrateWorkspace on the fresh box.
    expect(hydrateCalls).toHaveLength(1);
    expect(new TextDecoder().decode(hydrateCalls[0]!)).toBe(SNAPSHOT_REF);
    expect(established.instanceId).toBe("sb-fresh");
  });

  test("cold-restore with NO archive creates a fresh box and does NOT hydrate", async () => {
    hydrateCalls.length = 0;
    createArgs.length = 0;

    const established = await establishSandboxSessionFromEnvelope(
      modalSettings(),
      envelopeWithArchive(undefined),
      { sessionId: "sess-cold-noarch", environment: {} },
    );

    expect(createArgs).toHaveLength(1);
    expect("snapshot" in createArgs[0]!).toBe(false);
    expect(hydrateCalls).toHaveLength(0); // nothing to restore → clean empty box
    expect(established.instanceId).toBe("sb-fresh");
  });
});
