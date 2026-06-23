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
// sandboxId and terminates. createSandboxClientForBackend is mock-injected; the
// real deserialize/serialize/NotFound helpers run unmocked.

import { afterAll, describe, expect, mock, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import * as runtime from "@opengeni/runtime";

// Snapshot the REAL runtime exports BEFORE mocking so the mock factory can spread
// them (and the test can call the real serialize/deserialize directly).
const realRuntime = { ...runtime };

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
      return { kill: async () => {}, closed: false };
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

mock.module("@opengeni/runtime", () => ({
  ...realRuntime,
  createSandboxClientForBackend: (backend: string) =>
    backend === "modal" ? makeFakeModalClient() : undefined,
}));

afterAll(() => {
  mock.restore();
});

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
    const envelope = await realRuntime.serializeEstablishedSandboxEnvelope(established as never);
    expect(envelope).toBeTruthy();
    // sandboxId lives at envelope.sessionState.providerState.sandboxId — NOT at
    // the top level. Feeding the WHOLE envelope to the deserializer reads
    // top-level `providerState` (undefined) → drops sandboxId (the bug).
    const dropped = (await realRuntime.deserializeSandboxSessionStateEnvelope(
      makeFakeModalClient() as never,
      envelope as never,
    )) as { sandboxId?: unknown };
    expect(dropped?.sandboxId).toBeUndefined();
    // Unwrapping `.sessionState` first (what the working path / the fix does)
    // preserves sandboxId.
    const kept = (await realRuntime.deserializeSandboxSessionStateEnvelope(
      makeFakeModalClient() as never,
      (envelope as { sessionState?: unknown }).sessionState as never,
    )) as { sandboxId?: unknown };
    expect(kept?.sandboxId).toBe("sb-trap");
  });

  test("terminateProviderBox resumes by sandboxId and terminates (does NOT throw 'requires a persisted sandboxId')", async () => {
    resumeCalls.length = 0;
    deleteCalls.length = 0;

    // Dynamic import AFTER the mock so terminateProviderBox binds the fake
    // createSandboxClientForBackend.
    const { terminateProviderBox } = await import("../src/activities/sandbox-lease");

    const established = {
      client: makeFakeModalClient(),
      session: {},
      sessionState: { sandboxId: "sb-live-123", appName: "app", imageTag: "tag" },
      instanceId: "sb-live-123",
      backendId: "modal",
    };
    // The exact resume_state shape the lease stores on a turn / Channel-A commit.
    const resumeState = await realRuntime.serializeEstablishedSandboxEnvelope(established as never);

    const lease = {
      sandboxGroupId: "group-1",
      leaseEpoch: 1,
      backend: "modal",
      resumeBackendId: "modal",
      resumeState,
    };

    const settings = testSettings({ sandboxBackend: "modal", sandboxOwnershipEnabled: true });

    // Pre-fix this threw the Modal UserError; post-fix it resolves cleanly.
    await terminateProviderBox(settings, lease as never, observability);

    expect(resumeCalls).toEqual(["sb-live-123"]); // resumed BY ID, not thrown
    expect(deleteCalls).toEqual(["sb-live-123"]); // and terminated BY ID
  });
});
