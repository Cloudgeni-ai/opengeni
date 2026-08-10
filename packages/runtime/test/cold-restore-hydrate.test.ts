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
// A per-call client factory supplies a Modal-shaped fake: resume() throws
// NotFound; create() ASSERTS it is never handed a `snapshot` arg (mirroring
// assertCoreSnapshotUnsupported); the created session records hydrateWorkspace
// calls. The explicit factory avoids process-global module mocks whose result
// depends on which test imported the provider first.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  decodeModalSnapshotId,
  describeNativeSnapshotArchive,
  establishSandboxSessionFromEnvelope as establishRuntimeSandboxSessionFromEnvelope,
  readWorkspaceArchiveFromEnvelopeSessionState,
  SandboxResumeStateUnavailableError,
  SandboxResumeIdentityMismatchError,
  SandboxProviderContinuityUnavailableError,
} from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";

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
  async resumeExact() {
    return await this.resume();
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

function establishSandboxSessionFromEnvelope(
  settings: Parameters<typeof establishRuntimeSandboxSessionFromEnvelope>[0],
  envelope: Parameters<typeof establishRuntimeSandboxSessionFromEnvelope>[1],
  opts: Parameters<typeof establishRuntimeSandboxSessionFromEnvelope>[2],
) {
  return establishRuntimeSandboxSessionFromEnvelope(settings, envelope, {
    ...opts,
    clientFactory: () => new FakeModalSandboxClient(undefined),
  });
}

const SNAPSHOT_REF =
  'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-snap-abc","workspace_persistence":"snapshot_filesystem"}';
const SNAPSHOT_BYTES = new TextEncoder().encode(SNAPSHOT_REF);
const SNAPSHOT_B64 = Buffer.from(SNAPSHOT_BYTES).toString("base64");
const SNAPSHOT_PREV_REF =
  'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-snap-prev","workspace_persistence":"snapshot_filesystem"}';
const SNAPSHOT_PREV_B64 = Buffer.from(new TextEncoder().encode(SNAPSHOT_PREV_REF)).toString(
  "base64",
);
const TAR_BYTES = new TextEncoder().encode("PK-opengeni-test-tar");
const TAR_B64 = Buffer.from(TAR_BYTES).toString("base64");

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
    sessionState.workspaceArchiveMeta = describeNativeSnapshotArchive(bytes, 1_700_000_000_000) ?? {
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

  test.each([
    ["runloop", "devboxId", "devbox-existing"],
    ["blaxel", "sandboxIdentity", "blaxel-existing:created:workspace"],
  ] as const)(
    "resume-only recognizes the %s SDK legacy provider identity",
    async (backend, field, instanceId) => {
      let createCount = 0;
      const established = await establishRuntimeSandboxSessionFromEnvelope(
        testSettings({ sandboxBackend: "none" }),
        {
          backendId: backend,
          sessionState: { providerState: { [field]: instanceId } },
        },
        {
          sessionId: `sess-${backend}`,
          recovery: "resume-only",
          backendOverride: backend,
          environment: {},
          clientFactory: () => ({
            backendId: backend,
            async deserializeSessionState(state: Record<string, unknown>) {
              return state;
            },
            async resume(state: Record<string, unknown>) {
              return { state };
            },
            async resumeExact(state: Record<string, unknown>) {
              return { state };
            },
            async create() {
              createCount += 1;
              return { state: { [field]: "rival" } };
            },
          }),
        },
      );

      expect(established.instanceId).toBe(instanceId);
      expect(established.origin).toBe("resumed");
      expect(createCount).toBe(0);
    },
  );

  test("resume-only materializes the stable OpenGeni identity for a legacy SDK deserializer", async () => {
    let deserialized: Record<string, unknown> | null = null;
    const established = await establishRuntimeSandboxSessionFromEnvelope(
      testSettings({ sandboxBackend: "none" }),
      {
        backendId: "runloop",
        opengeniProviderInstanceId: "stable-existing",
        sessionState: { providerState: { providerPrivateAddress: "opaque" } },
      },
      {
        sessionId: "sess-stable-provider-identity",
        recovery: "resume-only",
        backendOverride: "runloop",
        environment: {},
        clientFactory: () => ({
          backendId: "runloop",
          async deserializeSessionState(state: Record<string, unknown>) {
            deserialized = state;
            return state;
          },
          async resume(state: Record<string, unknown>) {
            return { state };
          },
          async resumeExact(state: Record<string, unknown>) {
            return { state };
          },
        }),
      },
    );

    expect(deserialized).toMatchObject({
      providerPrivateAddress: "opaque",
      devboxId: "stable-existing",
    });
    expect(established.instanceId).toBe("stable-existing");
  });

  test("resume-only rejects disagreement between the durable and live provider identities", async () => {
    await expect(
      establishRuntimeSandboxSessionFromEnvelope(
        testSettings({ sandboxBackend: "none" }),
        {
          backendId: "runloop",
          opengeniProviderInstanceId: "devbox-authoritative",
          sessionState: { providerState: { devboxId: "devbox-stale" } },
        },
        {
          sessionId: "sess-provider-identity-mismatch",
          recovery: "resume-only",
          backendOverride: "runloop",
          environment: {},
          clientFactory: () => ({
            backendId: "runloop",
            async deserializeSessionState(state: Record<string, unknown>) {
              return state;
            },
            async resume() {
              return { state: { devboxId: "devbox-stale" } };
            },
            async resumeExact() {
              return { state: { devboxId: "devbox-stale" } };
            },
          }),
        },
      ),
    ).rejects.toMatchObject({
      name: SandboxResumeIdentityMismatchError.name,
      expectedInstanceId: "devbox-authoritative",
      actualInstanceId: "devbox-stale",
    });
  });

  test("resume-only discards an SDK-created replacement and reports the original missing", async () => {
    const calls: string[] = [];
    await expect(
      establishRuntimeSandboxSessionFromEnvelope(
        testSettings({ sandboxBackend: "none" }),
        {
          backendId: "runloop",
          opengeniProviderInstanceId: "devbox-gone",
          sessionState: { providerState: { devboxId: "devbox-gone" } },
        },
        {
          sessionId: "sess-sdk-replacement",
          recovery: "resume-only",
          backendOverride: "runloop",
          environment: {},
          clientFactory: () => ({
            backendId: "runloop",
            async deserializeSessionState(state: Record<string, unknown>) {
              return state;
            },
            async resume() {
              return {
                state: { devboxId: "devbox-replacement" },
                async delete() {
                  calls.push("replacement.delete");
                },
              };
            },
            async resumeExact() {
              return {
                state: { devboxId: "devbox-replacement" },
                async delete() {
                  calls.push("replacement.delete");
                },
              };
            },
          }),
        },
      ),
    ).rejects.toMatchObject({
      name: "SandboxExactResumeReplacedError",
      code: "SANDBOX_NOT_FOUND",
      expectedInstanceId: "devbox-gone",
      replacementInstanceId: "devbox-replacement",
    });
    expect(calls).toEqual(["replacement.delete"]);
  });

  test("the elected owner durably attributes a same-workspace Docker restart before use", async () => {
    const workspaceRootPath = "/tmp/opengeni-docker-continuity";
    const oldState = {
      containerId: "docker-old",
      workspaceRootPath,
      workspaceRootOwned: true,
      snapshot: null,
    };
    const continuity = {
      version: 1 as const,
      backend: "docker" as const,
      kind: "docker_workspace" as const,
      sourceInstanceId: "docker-old",
      continuityKey: workspaceRootPath,
    };
    const callbacks: string[] = [];
    let createCount = 0;
    const established = await establishRuntimeSandboxSessionFromEnvelope(
      testSettings({ sandboxBackend: "none" }),
      {
        backendId: "docker",
        opengeniProviderInstanceId: "docker-old",
        sessionState: { providerState: oldState },
        opengeniRecovery: { continuity },
      },
      {
        sessionId: "sess-docker-continuity",
        recovery: "create-or-restore",
        backendOverride: "docker",
        environment: {},
        clientFactory: () => ({
          backendId: "docker",
          async deserializeSessionState(state: Record<string, unknown>) {
            return state;
          },
          async resume(state: Record<string, unknown>) {
            callbacks.push("ordinary-resume");
            return { state: { ...state, containerId: "docker-new" } };
          },
          async resumeExact() {
            throw new Error("continuity owner must use the authorized replacement path");
          },
          async create() {
            createCount += 1;
            return { state: { ...oldState, containerId: "docker-rival" } };
          },
        }),
        onSandboxCreated: async (created) => {
          callbacks.push(`record:${created.instanceId}`);
          expect(created.providerContinuity).toEqual(continuity);
        },
      },
    );

    expect(established.instanceId).toBe("docker-new");
    expect(established.lostInstanceId).toBe("docker-old");
    expect(established.providerContinuity).toEqual(continuity);
    expect(callbacks).toEqual(["ordinary-resume", "record:docker-new"]);
    expect(createCount).toBe(0);
  });

  test("failed Docker continuity without an archive never creates an empty workspace", async () => {
    const workspaceRootPath = "/tmp/opengeni-docker-continuity-missing";
    let createCount = 0;
    await expect(
      establishRuntimeSandboxSessionFromEnvelope(
        testSettings({ sandboxBackend: "none" }),
        {
          backendId: "docker",
          opengeniProviderInstanceId: "docker-gone",
          sessionState: {
            providerState: {
              containerId: "docker-gone",
              workspaceRootPath,
              workspaceRootOwned: true,
              snapshot: null,
            },
          },
          opengeniRecovery: {
            continuity: {
              version: 1,
              backend: "docker",
              kind: "docker_workspace",
              sourceInstanceId: "docker-gone",
              continuityKey: workspaceRootPath,
            },
          },
        },
        {
          sessionId: "sess-docker-continuity-missing",
          recovery: "create-or-restore",
          backendOverride: "docker",
          environment: {},
          clientFactory: () => ({
            backendId: "docker",
            async deserializeSessionState(state: Record<string, unknown>) {
              return state;
            },
            async resume() {
              throw new Error(
                "Docker sandbox resources are unavailable and no local snapshot could be restored.",
              );
            },
            async create() {
              createCount += 1;
              return { state: { containerId: "empty-rival" } };
            },
          }),
        },
      ),
    ).rejects.toMatchObject({
      name: SandboxProviderContinuityUnavailableError.name,
      backend: "docker",
      sourceInstanceId: "docker-gone",
      retryable: false,
    });
    expect(createCount).toBe(0);
  });

  test("exact Vercel resume bypasses snapshot replacement and keeps recovery receipt", async () => {
    let receivedState: Record<string, unknown> | undefined;
    const established = await establishRuntimeSandboxSessionFromEnvelope(
      testSettings({ sandboxBackend: "none" }),
      {
        backendId: "vercel",
        opengeniProviderInstanceId: "sb-vercel-live",
        sessionState: {
          providerState: {
            sandboxId: "sb-vercel-live",
            snapshotId: "snap-durable",
            snapshotSandboxId: "sb-vercel-live",
          },
        },
      },
      {
        sessionId: "sess-vercel-exact",
        recovery: "resume-only",
        backendOverride: "vercel",
        environment: {},
        clientFactory: () => ({
          backendId: "vercel",
          async deserializeSessionState(state: Record<string, unknown>) {
            return state;
          },
          async resume(state: Record<string, unknown>) {
            receivedState = state;
            return { state };
          },
          async resumeExact(state: Record<string, unknown>) {
            receivedState = state;
            return { state };
          },
        }),
      },
    );

    expect(receivedState).toMatchObject({
      sandboxId: "sb-vercel-live",
      snapshotId: "snap-durable",
    });
    expect(receivedState).not.toHaveProperty("snapshotSandboxId");
    expect(established.instanceId).toBe("sb-vercel-live");
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

  test("a missing provider-immutable Modal image retries one fresh create from the logical image", async () => {
    const imageIds: Array<string | undefined> = [];
    const createMetrics: Array<{
      backend: string;
      imageSource: "logical" | "provider_immutable";
      outcome: "completed" | "failed";
    }> = [];
    const settings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: undefined,
      modalImageId: "im-stale-rig-image",
    });
    const logicalFallbackSettings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: undefined,
      modalImageId: "im-logical-base-image",
    });

    const established = await establishRuntimeSandboxSessionFromEnvelope(settings, null, {
      sessionId: "sess-stale-rig-image",
      recovery: "create-or-restore",
      environment: {},
      logicalFallbackSettings,
      clientFactory: (_backend, currentSettings) => {
        imageIds.push(currentSettings.modalImageId);
        const providerImmutable = currentSettings.modalImageId === "im-stale-rig-image";
        return {
          backendId: "modal",
          async create() {
            if (providerImmutable) throw { status: 404 };
            return { state: { sandboxId: "sb-logical-fallback" } };
          },
        };
      },
      metrics: {
        onSandboxCreate(input) {
          createMetrics.push(input);
        },
      },
    });

    expect(imageIds).toEqual(["im-stale-rig-image", "im-logical-base-image"]);
    expect(createMetrics).toEqual([
      expect.objectContaining({
        backend: "modal",
        imageSource: "provider_immutable",
        outcome: "failed",
      }),
      expect.objectContaining({
        backend: "modal",
        imageSource: "logical",
        outcome: "completed",
      }),
    ]);
    expect(established.instanceId).toBe("sb-logical-fallback");
    expect(established.origin).toBe("created");
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
        establishSandboxSessionFromEnvelope(modalSettings(), envelopeWithArchive(TAR_B64), {
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
