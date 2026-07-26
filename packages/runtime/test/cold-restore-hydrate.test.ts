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
// Controls for hydrateWorkspace-throw + delete tracking.
let hydrateWorkspaceFailuresRemaining = 0;
const deleteCalls: unknown[] = [];

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
      throw new Error(
        "assertCoreSnapshotUnsupported: ModalSandboxClient.create({ snapshot }) is unsupported",
      );
    }
    return {
      state: { sandboxId: "sb-fresh" },
      async hydrateWorkspace(data: Uint8Array) {
        if (hydrateWorkspaceFailuresRemaining > 0) {
          hydrateWorkspaceFailuresRemaining -= 1;
          throw new Error(
            "hydrateWorkspace: snapshot GC'd or provider timeout (test-injected failure)",
          );
        }
        hydrateCalls.push(data);
      },
    };
  }
  async delete(state: unknown) {
    deleteCalls.push(state);
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
  SandboxResumeStateUnavailableError,
} = await import("@opengeni/runtime");
const { testSettings } = await import("@opengeni/testing");

afterAll(() => {
  mock.restore();
});

const SNAPSHOT_REF =
  'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-snap-abc","workspace_persistence":"snapshot_filesystem"}';
const SNAPSHOT_BYTES = new TextEncoder().encode(SNAPSHOT_REF);
const SNAPSHOT_B64 = Buffer.from(SNAPSHOT_BYTES).toString("base64");
const SNAPSHOT_PREV_REF =
  'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-snap-prev","workspace_persistence":"snapshot_filesystem"}';
const SNAPSHOT_PREV_B64 = Buffer.from(new TextEncoder().encode(SNAPSHOT_PREV_REF)).toString(
  "base64",
);

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

function envelopeWithArchivePair(currentB64: string, previousB64: string) {
  const envelope = envelopeWithArchive(currentB64);
  (envelope.sessionState as Record<string, unknown>).workspaceArchivePrev = previousB64;
  return envelope;
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

  test("resume-only propagates provider NotFound and never creates a replacement", async () => {
    createArgs.length = 0;
    await expect(
      establishSandboxSessionFromEnvelope(modalSettings(), envelopeWithArchive(SNAPSHOT_B64), {
        sessionId: "sess-attached",
        recovery: "resume-only",
        environment: {},
      }),
    ).rejects.toThrow(/not found/i);
    expect(createArgs).toHaveLength(0);
  });

  test("resume-only rejects a missing provider identity and never creates", async () => {
    createArgs.length = 0;
    await expect(
      establishSandboxSessionFromEnvelope(modalSettings(), null, {
        sessionId: "sess-invalid-warm-lease",
        recovery: "resume-only",
        environment: {},
      }),
    ).rejects.toThrow(SandboxResumeStateUnavailableError);
    expect(createArgs).toHaveLength(0);
  });

  test("cold-restore creates a FRESH box (NO snapshot arg) and hydrates from the lease archive", async () => {
    hydrateCalls.length = 0;
    createArgs.length = 0;

    const established = await establishSandboxSessionFromEnvelope(
      modalSettings(),
      envelopeWithArchive(SNAPSHOT_B64),
      { sessionId: "sess-cold", recovery: "create-or-restore", environment: {} },
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
      { sessionId: "sess-cold-noarch", recovery: "create-or-restore", environment: {} },
    );

    expect(createArgs).toHaveLength(1);
    expect("snapshot" in createArgs[0]!).toBe(false);
    expect(hydrateCalls).toHaveLength(0); // nothing to restore → clean empty box
    expect(established.instanceId).toBe("sb-fresh");
  });

  test("cold-restore falls back to workspaceArchivePrev when current hydrate throws", async () => {
    hydrateCalls.length = 0;
    createArgs.length = 0;
    deleteCalls.length = 0;
    hydrateWorkspaceFailuresRemaining = 1;

    try {
      const established = await establishSandboxSessionFromEnvelope(
        modalSettings(),
        envelopeWithArchivePair(SNAPSHOT_B64, SNAPSHOT_PREV_B64),
        { sessionId: "sess-hydrate-prev", recovery: "create-or-restore", environment: {} },
      );

      expect(createArgs).toHaveLength(1);
      expect(deleteCalls.length).toBe(0);
      expect(hydrateCalls).toHaveLength(1);
      expect(new TextDecoder().decode(hydrateCalls[0]!)).toBe(SNAPSHOT_PREV_REF);
      expect(established.instanceId).toBe("sb-fresh");
    } finally {
      hydrateWorkspaceFailuresRemaining = 0;
    }
  });

  test("cold-restore with unusable archive falls through to a clean box", async () => {
    hydrateCalls.length = 0;
    createArgs.length = 0;
    deleteCalls.length = 0;
    hydrateWorkspaceFailuresRemaining = 1;

    try {
      const established = await establishSandboxSessionFromEnvelope(
        modalSettings(),
        envelopeWithArchive(SNAPSHOT_B64),
        {
          sessionId: "sess-hydrate-fail-open",
          recovery: "create-or-restore",
          environment: {},
        },
      );

      expect(established.instanceId).toBe("sb-fresh");
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0]).toMatchObject({ sandboxId: "sb-fresh" });
      expect(createArgs).toHaveLength(2);
      expect(hydrateCalls).toHaveLength(0);
      // Nothing was actually hydrated → must NOT report as restored-from-archive
      // (else sandbox.box.created would claim hydrated:"archive" on an empty box).
      expect(established.origin).toBe("created");
    } finally {
      hydrateWorkspaceFailuresRemaining = 0;
    }
  });
});
