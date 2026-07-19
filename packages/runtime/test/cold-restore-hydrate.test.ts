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
import { createHash } from "node:crypto";

// Mock the modal SDK BEFORE importing the runtime (so the modal provider's
// `new ModalSandboxClient(...)` constructs our fake).
const hydrateCalls: Uint8Array[] = [];
const createArgs: Array<{ manifest?: unknown; snapshot?: unknown }> = [];
// Controls for hydrateWorkspace-throw + delete tracking.
let hydrateWorkspaceFailuresRemaining = 0;
const deleteCalls: unknown[] = [];
const EXPECTED_WORKSPACE_SHA = "a".repeat(64);
let observedWorkspaceSha = EXPECTED_WORKSPACE_SHA;
let replaceInstanceOnHydrate = false;
const restoreEvents: string[] = [];

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
    const session = {
      state: { sandboxId: "sb-fresh" },
      async exec() {
        restoreEvents.push("fingerprint-exec");
        return {
          stdout: `OPENGENI_WORKSPACE_FINGERPRINT_V1 ${observedWorkspaceSha} 7 4 1234\n`,
        };
      },
      async hydrateWorkspace(data: Uint8Array) {
        if (hydrateWorkspaceFailuresRemaining > 0) {
          hydrateWorkspaceFailuresRemaining -= 1;
          throw new Error(
            "hydrateWorkspace: snapshot GC'd or provider timeout (test-injected failure)",
          );
        }
        hydrateCalls.push(data);
        restoreEvents.push("hydrate");
        if (replaceInstanceOnHydrate) {
          session.state.sandboxId = "sb-restored";
        }
      },
    };
    return session;
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
    const bytes = Buffer.from(archiveB64, "base64");
    const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
    sessionState.workspaceArchiveMeta = {
      version: 1,
      revision: `wa1:1700000000000:${archiveSha256}`,
      archiveSha256,
      archiveBytes: bytes.length,
      capturedAt: "2023-11-14T22:13:20.000Z",
      workspace: {
        algorithm: "sha256",
        sha256: EXPECTED_WORKSPACE_SHA,
        entryCount: 7,
        fileCount: 4,
        totalFileBytes: 1234,
      },
    };
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
    expect(established.origin).toBe("restored");
    expect(established.restoredArchive?.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("attributes a hydrate replacement before restore verification runs on it", async () => {
    hydrateCalls.length = 0;
    createArgs.length = 0;
    restoreEvents.length = 0;
    replaceInstanceOnHydrate = true;
    try {
      const createdIds: string[] = [];
      const established = await establishSandboxSessionFromEnvelope(
        modalSettings(),
        envelopeWithArchive(SNAPSHOT_B64),
        {
          sessionId: "sess-hydrate-replacement-order",
          recovery: "create-or-restore",
          environment: {},
          onSandboxCreated: async (created) => {
            createdIds.push(created.instanceId);
            restoreEvents.push(`attributed:${created.instanceId}`);
          },
          onWorkspaceRestoreVerifying: async () => {
            restoreEvents.push("restore-verifying");
          },
        },
      );

      expect(createdIds).toEqual(["sb-fresh", "sb-restored"]);
      expect(restoreEvents).toEqual([
        "attributed:sb-fresh",
        "hydrate",
        "attributed:sb-restored",
        "restore-verifying",
        "fingerprint-exec",
      ]);
      expect(established.instanceId).toBe("sb-restored");
    } finally {
      replaceInstanceOnHydrate = false;
    }
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

  test("cold-restore never silently selects workspaceArchivePrev when the selected revision fails", async () => {
    hydrateCalls.length = 0;
    createArgs.length = 0;
    deleteCalls.length = 0;
    hydrateWorkspaceFailuresRemaining = 1;

    try {
      await expect(
        establishSandboxSessionFromEnvelope(
          modalSettings(),
          envelopeWithArchivePair(SNAPSHOT_B64, SNAPSHOT_PREV_B64),
          { sessionId: "sess-hydrate-prev", recovery: "create-or-restore", environment: {} },
        ),
      ).rejects.toMatchObject({ code: "archive_hydration_failed" });
      expect(createArgs).toHaveLength(1);
      expect(deleteCalls.length).toBe(1);
      expect(hydrateCalls).toHaveLength(0);
    } finally {
      hydrateWorkspaceFailuresRemaining = 0;
    }
  });

  test("cold-restore with unusable archive fails closed and never exposes a clean box", async () => {
    hydrateCalls.length = 0;
    createArgs.length = 0;
    deleteCalls.length = 0;
    hydrateWorkspaceFailuresRemaining = 1;

    try {
      await expect(
        establishSandboxSessionFromEnvelope(modalSettings(), envelopeWithArchive(SNAPSHOT_B64), {
          sessionId: "sess-hydrate-fail-closed",
          recovery: "create-or-restore",
          environment: {},
        }),
      ).rejects.toMatchObject({ code: "archive_hydration_failed" });
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0]).toMatchObject({ sandboxId: "sb-fresh" });
      expect(createArgs).toHaveLength(1);
      expect(hydrateCalls).toHaveLength(0);
    } finally {
      hydrateWorkspaceFailuresRemaining = 0;
    }
  });

  test("cold-restore blocks a plausible partial workspace whose tree fingerprint differs", async () => {
    hydrateCalls.length = 0;
    createArgs.length = 0;
    deleteCalls.length = 0;
    observedWorkspaceSha = "b".repeat(64);
    try {
      await expect(
        establishSandboxSessionFromEnvelope(modalSettings(), envelopeWithArchive(SNAPSHOT_B64), {
          sessionId: "sess-partial-restore",
          recovery: "create-or-restore",
          environment: {},
        }),
      ).rejects.toMatchObject({ code: "workspace_fingerprint_mismatch" });
      expect(deleteCalls).toHaveLength(1);
      expect(createArgs).toHaveLength(1);
      expect(hydrateCalls).toHaveLength(1);
    } finally {
      observedWorkspaceSha = EXPECTED_WORKSPACE_SHA;
    }
  });
});
