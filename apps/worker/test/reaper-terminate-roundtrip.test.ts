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
import { testSettings } from "@opengeni/testing";
import * as runtime from "@opengeni/runtime";
import { terminateProviderBox } from "../src/activities/sandbox-lease";

// A Modal-faithful fake provider client. resume() enforces the SAME invariant the
// real SDK does (throws when state.sandboxId is absent), so a regressed envelope
// unwrap reproduces the production failure exactly.
const resumeCalls: Array<string | undefined> = [];
const deleteCalls: Array<string | undefined> = [];
function makeFakeModalClient() {
  return {
    backendId: "modal",
    async deserializeSessionState(state: Record<string, unknown>) {
      // Echo (preserves sandboxId iff present), like the SDK's `...state` spread.
      return { ...state, ownsSandbox: true };
    },
    async resume(state: { sandboxId?: unknown }) {
      if (!state.sandboxId) {
        throw new Error("Modal sandbox resume requires a persisted sandboxId.");
      }
      resumeCalls.push(state.sandboxId as string);
      // The resumed live session exposes persistWorkspace() (the snapshot/tar
      // capture) — terminateProviderBox MUST call it BEFORE delete().
      return {
        kill: async () => {},
        closed: false,
        persistWorkspace: async () =>
          new TextEncoder().encode('MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-snap-123"}'),
        modal: { images: { delete: async () => {} } },
      };
    },
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
      return { wrote: true, priorArchive: null, priorArchivePrev: null };
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

    expect(terminated).toBe(true);
    expect(resumeCalls).toEqual(["sb-live-123"]); // resumed BY ID, not thrown
    // persistWorkspace was captured and folded onto the lease BEFORE terminate.
    expect(persistedArchives).toHaveLength(1);
    expect(Buffer.from(persistedArchives[0]!, "base64").toString("utf8")).toContain(
      "MODAL_SANDBOX_FS_SNAPSHOT_V1",
    );
    expect(deleteCalls).toEqual(["sb-live-123"]); // and terminated BY ID, AFTER persist
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
      return { wrote: true as const, priorArchive: null, priorArchivePrev: null };
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
    expect(drainedCold).toBe(true);
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
          kill: async () => {},
          closed: false,
          persistWorkspace: async () => {
            throw new Error("Modal snapshot_filesystem persistence timed out.");
          },
        };
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
      resumeBackendId: "modal",
      resumeState,
    };
    const settings = testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true });

    const persistArchive = async () => ({
      wrote: true as const,
      priorArchive: null,
      priorArchivePrev: null,
    });

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
});
