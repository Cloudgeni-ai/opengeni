// Regression for the reaper terminate envelope→resume round-trip (no docker/no
// live provider). The bug: the reaper passed the WHOLE lease envelope
// `{ backendId, sessionState: { providerState: { sandboxId, ... }, ... } }`
// straight to deserializeSandboxSessionStateEnvelope, which reads
// `state.providerState` at the TOP level — but providerState is nested one level
// down under `sessionState`. So sandboxId was dropped and Modal's resume() threw
// "Modal sandbox resume requires a persisted sandboxId" → every drainable Modal
// box leaked (drainable:N, terminated:0). The working resume-by-id paths
// (establishSandboxSessionFromEnvelope) unwrap `envelope.sessionState` FIRST; the
// fix makes terminateProviderBox do the same.
//
// This test drives the REAL terminateProviderBox against a Modal-FAITHFUL fake
// client (resume() throws the exact UserError when sandboxId is missing, exactly
// like the SDK) over a PRODUCTION envelope built by the real
// serializeEstablishedSandboxEnvelope. Pre-fix it threw; post-fix it resumes by
// sandboxId and terminates. The provider client builder is injected explicitly so
// this test does not mock @opengeni/runtime globally and poison unrelated tests.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSettings } from "@opengeni/testing";
import * as runtime from "@opengeni/runtime";
import {
  SandboxProviderCaptureTimeoutError,
  terminateProviderBox,
} from "../src/activities/sandbox-lease";

// A Modal-faithful fake provider client. resume() enforces the SAME invariant the
// real SDK does (throws when state.sandboxId is absent), so a regressed envelope
// unwrap reproduces the production failure exactly.
const resumeCalls: Array<string | undefined> = [];
const deleteCalls: Array<string | undefined> = [];
const TEST_WORKSPACE_FINGERPRINT =
  "OPENGENI_WORKSPACE_FINGERPRINT_V1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 2 17\n";
function makeFakeModalClient() {
  const resumeExact = async (state: { sandboxId?: unknown }) => {
    if (!state.sandboxId) {
      throw new Error("Modal sandbox resume requires a persisted sandboxId.");
    }
    resumeCalls.push(state.sandboxId as string);
    // The resumed live session exposes persistWorkspace() (the snapshot/tar
    // capture) — terminateProviderBox MUST call it BEFORE delete().
    return {
      state: { sandboxId: state.sandboxId },
      kill: async () => {},
      closed: false,
      exec: async () => ({ stdout: TEST_WORKSPACE_FINGERPRINT }),
      persistWorkspace: async () =>
        new TextEncoder().encode('MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-snap-123"}'),
      modal: { images: { delete: async () => {} } },
    };
  };
  return {
    backendId: "modal",
    async deserializeSessionState(state: Record<string, unknown>) {
      // Echo (preserves sandboxId iff present), like the SDK's `...state` spread.
      return { ...state, ownsSandbox: true };
    },
    resume: resumeExact,
    resumeExact,
    async serializeSessionState(state: Record<string, unknown>) {
      // The persistable FLAT provider state (sandboxId at the top), like Modal.
      return { ...state };
    },
    async delete(state: { sandboxId?: unknown }) {
      deleteCalls.push(state?.sandboxId as string | undefined);
    },
  };
}

const observability = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as never;

describe("reaper terminate envelope→resume round-trip preserves sandboxId", () => {
  test("normalizes the SDK local ID and cold-commits an unavailable process-local workspace", async () => {
    const clientBuilds: string[] = [];
    const localClient = {
      backendId: "unix_local",
      async deserializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
      async resume() {
        throw new Error(
          "UnixLocal sandbox workspace is unavailable and no local snapshot could be restored.",
        );
      },
      async resumeExact() {
        throw new Error(
          "UnixLocal sandbox workspace is unavailable and no local snapshot could be restored.",
        );
      },
    };

    const persistCalls: unknown[] = [];
    const outcome = await terminateProviderBox(
      testSettings({ sandboxBackend: "local", sandboxOwnershipEnabled: true }),
      {
        sandboxGroupId: "group-local-sdk-id",
        leaseEpoch: 1,
        backend: "local",
        instanceId: "/tmp/opengeni-local-workspace",
        resumeBackendId: "unix_local",
        resumeState: {
          backendId: "unix_local",
          sessionState: {
            providerState: { workspaceRootPath: "/tmp/opengeni-local-workspace" },
          },
        },
      } as never,
      observability,
      async (...args) => {
        persistCalls.push(args);
        return { wrote: true };
      },
      ((backend: string) => {
        clientBuilds.push(backend);
        return localClient;
      }) as never,
    );

    expect(clientBuilds).toEqual(["local"]);
    expect(outcome).toEqual({
      terminated: true,
      providerMissingBeforeCapture: true,
    });
    expect(persistCalls).toHaveLength(0);
  });

  test("a claimed Docker drain restarts only the same live workspace, captures it, then removes it", async () => {
    const calls: string[] = [];
    const workspaceRootPath = mkdtempSync(join(tmpdir(), "opengeni-docker-reaper-continuity-"));
    writeFileSync(join(workspaceRootPath, "latest.txt"), "latest-docker-workspace");
    const providerState = {
      containerId: "docker-old",
      workspaceRootPath,
      workspaceRootOwned: true,
      snapshot: null,
    };
    const dockerArchive = JSON.stringify({
      version: 1,
      directories: [],
      files: [
        {
          path: "latest.txt",
          data: Buffer.from("latest-docker-workspace").toString("base64"),
        },
      ],
    });
    const client = {
      backendId: "docker",
      async deserializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
      async resume(state: Record<string, unknown>) {
        calls.push("restart-same-workspace");
        return {
          state: { ...state, containerId: "docker-new" },
          exec: async () => ({ stdout: TEST_WORKSPACE_FINGERPRINT }),
          persistWorkspace: async () => new TextEncoder().encode(dockerArchive),
          delete: async () => calls.push("delete-workspace-and-wrapper"),
        };
      },
    };
    try {
      const archives: string[] = [];
      const outcome = await terminateProviderBox(
        testSettings({ sandboxBackend: "docker", sandboxOwnershipEnabled: true }),
        {
          sandboxGroupId: "group-docker-continuity",
          leaseEpoch: 4,
          backend: "docker",
          instanceId: "docker-old",
          resumeBackendId: "docker",
          resumeState: {
            backendId: "docker",
            opengeniProviderInstanceId: "docker-old",
            sessionState: { providerState },
          },
        } as never,
        observability,
        async (archive) => {
          expect(calls).not.toContain("delete-workspace-and-wrapper");
          archives.push(archive);
          return { wrote: true };
        },
        (() => client) as never,
      );

      expect(outcome).toEqual({
        terminated: true,
        providerMissingBeforeCapture: false,
      });
      expect(archives).toHaveLength(1);
      expect(Buffer.from(archives[0]!, "base64").toString()).toBe(dockerArchive);
      expect(calls).toEqual(["restart-same-workspace", "delete-workspace-and-wrapper"]);
    } finally {
      rmSync(workspaceRootPath, { recursive: true, force: true });
    }
  });

  test("the PRODUCTION envelope nests providerState under sessionState (the trap)", async () => {
    const established = {
      client: makeFakeModalClient(),
      session: {},
      sessionState: { sandboxId: "sb-trap", appName: "app", imageTag: "tag" },
      instanceId: "sb-trap",
      backendId: "modal",
    };
    const envelope = await runtime.serializeEstablishedSandboxEnvelope(established as never);
    expect(envelope).toBeTruthy();
    // sandboxId lives at envelope.sessionState.providerState.sandboxId — NOT at
    // the top level. Feeding the WHOLE envelope to the deserializer reads
    // top-level `providerState` (undefined) → drops sandboxId (the bug).
    const dropped = (await runtime.deserializeSandboxSessionStateEnvelope(
      makeFakeModalClient() as never,
      envelope as never,
    )) as { sandboxId?: unknown };
    expect(dropped?.sandboxId).toBeUndefined();
    // Unwrapping `.sessionState` first (what the working path / the fix does)
    // preserves sandboxId.
    const kept = (await runtime.deserializeSandboxSessionStateEnvelope(
      makeFakeModalClient() as never,
      (envelope as { sessionState?: unknown }).sessionState as never,
    )) as { sandboxId?: unknown };
    expect(kept?.sandboxId).toBe("sb-trap");
  });

  test("terminateProviderBox resumes by sandboxId and terminates (does NOT throw 'requires a persisted sandboxId')", async () => {
    resumeCalls.length = 0;
    deleteCalls.length = 0;

    const established = {
      client: makeFakeModalClient(),
      session: {},
      sessionState: { sandboxId: "sb-live-123", appName: "app", imageTag: "tag" },
      instanceId: "sb-live-123",
      backendId: "modal",
    };
    // The exact resume_state shape the lease stores on a turn / Channel-A commit.
    const resumeState = await runtime.serializeEstablishedSandboxEnvelope(established as never);

    const lease = {
      sandboxGroupId: "group-1",
      leaseEpoch: 1,
      backend: "modal",
      instanceId: "sb-live-123",
      resumeBackendId: "modal",
      resumeState,
    };

    const settings = testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true });

    // Capture the persist-before-terminate seam: the archive must be folded onto
    // the lease (returned wrote:true) BEFORE delete() fires.
    const persistedArchives: string[] = [];
    const persistArchive = async (archiveBase64: string) => {
      // A persistArchive call must precede the terminate (delete) call.
      expect(deleteCalls).toHaveLength(0);
      persistedArchives.push(archiveBase64);
      return { wrote: true };
    };

    // Pre-fix this threw the Modal UserError; post-fix it resolves cleanly.
    // Inject the fake Modal client so no live provider box is created.
    const terminated = await terminateProviderBox(
      settings,
      lease as never,
      observability,
      persistArchive,
      ((backend: string) => (backend === "modal" ? makeFakeModalClient() : undefined)) as never,
    );

    expect(terminated).toEqual({
      terminated: true,
      providerMissingBeforeCapture: false,
    });
    expect(resumeCalls).toEqual(["sb-live-123"]); // resumed BY ID, not thrown
    // persistWorkspace was captured and folded onto the lease BEFORE terminate.
    expect(persistedArchives).toHaveLength(1);
    expect(Buffer.from(persistedArchives[0]!, "base64").toString("utf8")).toContain(
      "MODAL_SANDBOX_FS_SNAPSHOT_V1",
    );
    expect(deleteCalls).toEqual(["sb-live-123"]); // and terminated BY ID, AFTER persist
  });

  test("a durably published drain resumes exact teardown without another workspace capture", async () => {
    resumeCalls.length = 0;
    deleteCalls.length = 0;
    const resumeState = await runtime.serializeEstablishedSandboxEnvelope({
      client: makeFakeModalClient(),
      session: {},
      sessionState: { sandboxId: "sb-published", appName: "app", imageTag: "tag" },
      instanceId: "sb-published",
      backendId: "modal",
    } as never);
    let persistCalls = 0;
    const outcome = await terminateProviderBox(
      testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true }),
      {
        sandboxGroupId: "group-published",
        leaseEpoch: 9,
        backend: "modal",
        instanceId: "sb-published",
        resumeBackendId: "modal",
        resumeState,
      } as never,
      observability,
      async () => {
        persistCalls += 1;
        return { wrote: true };
      },
      ((backend: string) => (backend === "modal" ? makeFakeModalClient() : undefined)) as never,
      undefined,
      undefined,
      "archive_published",
    );

    expect(outcome).toEqual({
      terminated: true,
      providerMissingBeforeCapture: false,
    });
    expect(resumeCalls).toEqual(["sb-published"]);
    expect(persistCalls).toBe(0);
    expect(deleteCalls).toEqual(["sb-published"]);
  });

  test("a generic provider timeout preserves and late-publishes the exact capture without teardown", async () => {
    let resolveCapture!: (bytes: Uint8Array) => void;
    const providerCapture = new Promise<Uint8Array>((resolve) => {
      resolveCapture = resolve;
    });
    let deleteCount = 0;
    const client = {
      backendId: "modal",
      async deserializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
      async resume(state: { sandboxId?: unknown }) {
        return {
          state: { sandboxId: state.sandboxId },
          exec: async () => ({ stdout: TEST_WORKSPACE_FINGERPRINT }),
          persistWorkspace: async () => await providerCapture,
          kill: async () => {},
          closed: false,
          modal: { images: { delete: async () => {} } },
        };
      },
      async resumeExact(state: { sandboxId?: unknown }) {
        return await this.resume(state);
      },
      async delete() {
        deleteCount += 1;
      },
    };
    let resolvePublished!: () => void;
    const published = new Promise<void>((resolve) => {
      resolvePublished = resolve;
    });
    let publishedArchive: string | null = null;
    const operation = terminateProviderBox(
      testSettings({
        sandboxBackend: "modal",
        sandboxOwnershipEnabled: true,
        sandboxSnapshotTimeoutMs: 10,
      }),
      {
        sandboxGroupId: "group-late-capture",
        leaseEpoch: 3,
        backend: "modal",
        instanceId: "sb-late-capture",
        resumeBackendId: "modal",
        resumeState: {
          backendId: "modal",
          sessionState: { providerState: { sandboxId: "sb-late-capture" } },
        },
      } as never,
      observability,
      async (archive) => {
        publishedArchive = archive;
        resolvePublished();
        return { wrote: true };
      },
      (() => client) as never,
    );

    await expect(operation).rejects.toBeInstanceOf(SandboxProviderCaptureTimeoutError);
    expect(deleteCount).toBe(0);
    resolveCapture(
      new TextEncoder().encode('MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-late"}'),
    );
    await Promise.race([
      published,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("late capture did not publish")), 1_000),
      ),
    ]);
    expect(publishedArchive).not.toBeNull();
    expect(deleteCount).toBe(0);
  });

  test("a Modal warming-death record uses the exact attributed instance without guessing an envelope", async () => {
    const directTerminateCalls: string[] = [];
    const clientBuilds: string[] = [];
    const persistCalls: Array<string | null> = [];
    const outcome = await terminateProviderBox(
      testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true }),
      {
        sandboxGroupId: "group-unpublished-modal",
        leaseEpoch: 4,
        backend: "modal",
        instanceId: "sb-unpublished-modal",
        resumeBackendId: "modal",
        resumeState: {
          opengeniRecovery: {
            provider: { status: "creating", instanceId: "sb-unpublished-modal" },
            workspace: { status: "not_ready" },
          },
        },
        recovery: {
          provider: { status: "creating", instanceId: "sb-unpublished-modal" },
          workspace: { status: "not_ready" },
        },
      } as never,
      observability,
      async (archiveBase64) => {
        persistCalls.push(archiveBase64);
        return { wrote: true };
      },
      ((backend: string) => {
        clientBuilds.push(backend);
        throw new Error("provider client must not be built for unpublished Modal state");
      }) as never,
      (async (_settings: unknown, instanceId: string) => {
        directTerminateCalls.push(instanceId);
      }) as never,
    );

    expect(outcome).toEqual({
      terminated: true,
      providerMissingBeforeCapture: false,
    });
    expect(persistCalls).toEqual([null]);
    expect(directTerminateCalls).toEqual(["sb-unpublished-modal"]);
    expect(clientBuilds).toEqual([]);
  });

  test("a re-armed unpublished Modal lease is left running", async () => {
    const directTerminateCalls: string[] = [];
    const outcome = await terminateProviderBox(
      testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true }),
      {
        sandboxGroupId: "group-rearmed-modal",
        leaseEpoch: 5,
        backend: "modal",
        instanceId: "sb-rearmed-modal",
        resumeBackendId: "modal",
        resumeState: null,
        recovery: {
          provider: { status: "creating", instanceId: "sb-rearmed-modal" },
          workspace: { status: "not_ready" },
        },
      } as never,
      observability,
      async () => ({ wrote: false }),
      (() => {
        throw new Error("provider client must not be built");
      }) as never,
      (async (_settings: unknown, instanceId: string) => {
        directTerminateCalls.push(instanceId);
      }) as never,
    );

    expect(outcome).toEqual({
      terminated: false,
      providerMissingBeforeCapture: false,
    });
    expect(directTerminateCalls).toEqual([]);
  });

  test("provider identity disagreement fails closed before any provider operation", async () => {
    const clientBuilds: string[] = [];
    const persistCalls: unknown[] = [];
    await expect(
      terminateProviderBox(
        testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true }),
        {
          sandboxGroupId: "group-mismatch",
          leaseEpoch: 6,
          backend: "modal",
          instanceId: "sb-authoritative",
          resumeBackendId: "modal",
          resumeState: {
            opengeniProviderInstanceId: "sb-stale-envelope",
            sessionState: { providerState: { sandboxId: "sb-stale-envelope" } },
          },
        } as never,
        observability,
        async (...args) => {
          persistCalls.push(args);
          return { wrote: true };
        },
        ((backend: string) => {
          clientBuilds.push(backend);
          return makeFakeModalClient();
        }) as never,
      ),
    ).rejects.toThrow(/does not match persisted provider identity/);
    expect(clientBuilds).toEqual([]);
    expect(persistCalls).toEqual([]);
  });

  test("a persisted provider identity without an authoritative lease instance fails closed", async () => {
    await expect(
      terminateProviderBox(
        testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true }),
        {
          sandboxGroupId: "group-missing-authority",
          leaseEpoch: 7,
          backend: "modal",
          instanceId: null,
          resumeBackendId: "modal",
          resumeState: { opengeniProviderInstanceId: "sb-unattributed" },
        } as never,
        observability,
        async () => ({ wrote: true }),
        (() => {
          throw new Error("provider client must not be built");
        }) as never,
      ),
    ).rejects.toThrow(/no authoritative lease instance/);
  });

  test("non-identity provider configuration is never guessed as a provider address", async () => {
    const clientBuilds: string[] = [];
    await expect(
      terminateProviderBox(
        testSettings({ sandboxBackend: "runloop", sandboxOwnershipEnabled: true }),
        {
          sandboxGroupId: "group-runloop-config-only",
          leaseEpoch: 8,
          backend: "runloop",
          instanceId: "devbox-attributed-but-unresumable",
          resumeBackendId: "runloop",
          resumeState: {
            sessionState: { providerState: { region: "us-west", timeoutSeconds: 300 } },
          },
          recovery: {
            provider: { status: "unknown", instanceId: "devbox-attributed-but-unresumable" },
            workspace: { status: "unknown" },
          },
        } as never,
        observability,
        async () => ({ wrote: true }),
        ((backend: string) => {
          clientBuilds.push(backend);
          return undefined;
        }) as never,
      ),
    ).rejects.toThrow(/no resumable provider envelope/);
    expect(clientBuilds).toEqual([]);
  });

  test("an already-closed resumable session idempotently runs its declared cleanup", async () => {
    const closeCalls: string[] = [];
    const persistedArchives: string[] = [];
    const closeOnlyClient = {
      backendId: "modal",
      async deserializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
      async resume() {
        return {
          state: { sandboxId: "sb-already-closed" },
          closed: true,
          close: async () => {
            closeCalls.push("close");
          },
          exec: async () => ({ stdout: TEST_WORKSPACE_FINGERPRINT }),
          persistWorkspace: async () =>
            new TextEncoder().encode(
              'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-already-closed"}',
            ),
        };
      },
      async resumeExact() {
        return await this.resume();
      },
      async serializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
    };

    const outcome = await terminateProviderBox(
      testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true }),
      {
        sandboxGroupId: "group-already-closed",
        leaseEpoch: 3,
        backend: "modal",
        instanceId: "sb-already-closed",
        resumeBackendId: "modal",
        resumeState: {
          backendId: "modal",
          sessionState: { providerState: { sandboxId: "sb-already-closed" } },
        },
      } as never,
      observability,
      async (archiveBase64) => {
        expect(archiveBase64).not.toBeNull();
        persistedArchives.push(archiveBase64!);
        return { wrote: true };
      },
      (() => closeOnlyClient) as never,
    );

    expect(outcome).toEqual({
      terminated: true,
      providerMissingBeforeCapture: false,
    });
    expect(persistedArchives).toHaveLength(1);
    expect(closeCalls).toEqual(["close"]);
  });

  test("CRITICAL: a selfhosted lease is NEVER provider-stopped by the reaper (drain-to-cold only)", async () => {
    // The catastrophic-if-violated invariant: a selfhosted box is
    // a user's PHYSICAL machine. The reaper must drain its lease to cold WITHOUT
    // building a provider client, resuming, snapshotting, or calling delete()/kill().
    // We inject a spy client that records EVERY call; for a selfhosted lease the spy
    // must be touched ZERO times, and terminateProviderBox must still return true so
    // the caller's confirmDrainCold flips the lease draining→cold.
    const clientBuilds: string[] = [];
    const selfhostedResumeCalls: string[] = [];
    const selfhostedDeleteCalls: string[] = [];
    const spyClientFactory = ((backend: string) => {
      clientBuilds.push(backend);
      return {
        backendId: backend,
        async deserializeSessionState(state: Record<string, unknown>) {
          return { ...state };
        },
        async resume() {
          selfhostedResumeCalls.push(backend);
          return {
            kill: async () => {
              selfhostedDeleteCalls.push("kill");
            },
            closed: false,
          };
        },
        async serializeSessionState(state: Record<string, unknown>) {
          return { ...state };
        },
        async delete() {
          selfhostedDeleteCalls.push("delete");
        },
      };
    }) as never;

    const persistCalls: Array<string | null> = [];
    const persistArchive = async (archiveBase64: string | null) => {
      persistCalls.push(archiveBase64);
      return { wrote: true as const };
    };

    // A fully-populated selfhosted lease envelope: resumeState present, backend
    // selfhosted on BOTH the lease and the resume envelope. Even with a non-empty
    // envelope (the guard must not depend on an empty one), nothing must fire.
    const lease = {
      sandboxGroupId: "group-selfhosted",
      leaseEpoch: 1,
      backend: "selfhosted",
      resumeBackendId: "selfhosted",
      resumeState: { backendId: "selfhosted", sessionState: { agentId: "agent-abc" } },
    };
    const settings = testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true });

    const drainedCold = await terminateProviderBox(
      settings,
      lease as never,
      observability,
      persistArchive,
      spyClientFactory,
    );

    // Drain-to-cold succeeds (the lease can go cold) ...
    expect(drainedCold).toEqual({
      terminated: true,
      providerMissingBeforeCapture: false,
    });
    // ... but the provider was NEVER touched: no client built, no resume, no
    // delete/kill, and no snapshot persist attempted (the machine IS the persistence).
    expect(clientBuilds).toEqual([]);
    expect(selfhostedResumeCalls).toEqual([]);
    expect(selfhostedDeleteCalls).toEqual([]);
    expect(persistCalls).toEqual([]);
  });

  test("a persistWorkspace failure does NOT terminate the box (re-throws → lease stays draining)", async () => {
    resumeCalls.length = 0;
    deleteCalls.length = 0;

    // A client whose resumed session FAILS to snapshot (provider snapshot error).
    const failClient = {
      backendId: "modal",
      async deserializeSessionState(state: Record<string, unknown>) {
        return { ...state, ownsSandbox: true };
      },
      async resume() {
        resumeCalls.push("sb-nosnap");
        return {
          state: { sandboxId: "sb-nosnap" },
          kill: async () => {},
          closed: false,
          exec: async () => ({ stdout: TEST_WORKSPACE_FINGERPRINT }),
          persistWorkspace: async () => {
            throw new Error("Modal snapshot_filesystem persistence timed out.");
          },
        };
      },
      async resumeExact() {
        return await this.resume();
      },
      async serializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
      async delete(state: { sandboxId?: unknown }) {
        deleteCalls.push(state?.sandboxId as string | undefined);
      },
    };

    const established = {
      client: failClient,
      session: {},
      sessionState: { sandboxId: "sb-nosnap", appName: "app", imageTag: "tag" },
      instanceId: "sb-nosnap",
      backendId: "modal",
    };
    const resumeState = await runtime.serializeEstablishedSandboxEnvelope(established as never);
    const lease = {
      sandboxGroupId: "group-nosnap",
      leaseEpoch: 1,
      backend: "modal",
      instanceId: "sb-nosnap",
      resumeBackendId: "modal",
      resumeState,
    };
    const settings = testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true });

    const persistArchive = async () => ({ wrote: true as const });

    // The snapshot failure must propagate (so the caller skips + leaves the lease
    // draining); the box is NEVER terminated with un-captured files. The failing
    // client is injected explicitly (no global @opengeni/runtime mock).
    await expect(
      terminateProviderBox(settings, lease as never, observability, persistArchive, ((
        backend: string,
      ) => (backend === "modal" ? failClient : undefined)) as never),
    ).rejects.toThrow(/snapshot_filesystem persistence timed out/);
    expect(deleteCalls).toHaveLength(0); // box deliberately NOT terminated
  });

  test("provider NotFound before capture is returned as typed missing-workspace evidence", async () => {
    const notFoundClient = {
      backendId: "modal",
      async deserializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
      async resume() {
        const error = new Error("Sandbox sb-gone was not found");
        Object.assign(error, { status: 404, code: "NOT_FOUND" });
        throw error;
      },
      async resumeExact() {
        return await this.resume();
      },
    };
    const lease = {
      sandboxGroupId: "group-gone",
      leaseEpoch: 7,
      backend: "modal",
      instanceId: "sb-gone",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "sb-gone" } },
      },
    };
    const persistCalls: unknown[] = [];

    const outcome = await terminateProviderBox(
      testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true }),
      lease as never,
      observability,
      async (...args) => {
        persistCalls.push(args);
        return { wrote: true };
      },
      (() => notFoundClient) as never,
    );

    expect(outcome).toEqual({
      terminated: true,
      providerMissingBeforeCapture: true,
    });
    expect(persistCalls).toHaveLength(0);
  });

  test("an SDK-created resume replacement is deleted and never captured as the original", async () => {
    const replacementDeletes: string[] = [];
    const replacementClient = {
      backendId: "runloop",
      async deserializeSessionState(state: Record<string, unknown>) {
        return { ...state };
      },
      async resume() {
        return {
          state: { devboxId: "devbox-replacement" },
          async delete() {
            replacementDeletes.push("devbox-replacement");
          },
          async persistWorkspace() {
            throw new Error("replacement must never be captured");
          },
        };
      },
      async resumeExact() {
        return await this.resume();
      },
    };
    const persistCalls: unknown[] = [];

    const outcome = await terminateProviderBox(
      testSettings({ sandboxBackend: "runloop", sandboxOwnershipEnabled: true }),
      {
        sandboxGroupId: "group-recreated-by-sdk",
        leaseEpoch: 9,
        backend: "runloop",
        instanceId: "devbox-gone",
        resumeBackendId: "runloop",
        resumeState: {
          backendId: "runloop",
          opengeniProviderInstanceId: "devbox-gone",
          sessionState: { providerState: { devboxId: "devbox-gone" } },
        },
      } as never,
      observability,
      async (...args) => {
        persistCalls.push(args);
        return { wrote: true };
      },
      (() => replacementClient) as never,
    );

    expect(outcome).toEqual({
      terminated: true,
      providerMissingBeforeCapture: true,
    });
    expect(replacementDeletes).toEqual(["devbox-replacement"]);
    expect(persistCalls).toHaveLength(0);
  });

  test("an ambiguous provider termination failure is never reported as success", async () => {
    const terminateFailureClient = {
      ...makeFakeModalClient(),
      async delete() {
        throw new Error("provider transport reset during terminate");
      },
    };
    const resumeState = await runtime.serializeEstablishedSandboxEnvelope({
      client: terminateFailureClient,
      session: {},
      sessionState: { sandboxId: "sb-ambiguous", appName: "app", imageTag: "tag" },
      instanceId: "sb-ambiguous",
      backendId: "modal",
    } as never);

    await expect(
      terminateProviderBox(
        testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true }),
        {
          sandboxGroupId: "group-ambiguous",
          leaseEpoch: 8,
          backend: "modal",
          instanceId: "sb-ambiguous",
          resumeBackendId: "modal",
          resumeState,
        } as never,
        observability,
        async () => ({ wrote: true }),
        (() => terminateFailureClient) as never,
      ),
    ).rejects.toThrow(/provider transport reset during terminate/);
  });
});
