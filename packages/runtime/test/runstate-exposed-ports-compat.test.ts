import { afterEach, describe, expect, test } from "bun:test";
import { RunContext, RunState } from "@openai/agents-core";
import { testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  deserializeSandboxSessionStateEnvelope,
  prepareRunInput,
  repairSerializedRunStateExposedPorts,
  serializeEstablishedSandboxEnvelope,
} from "../src";

const originalConsoleWarn = console.warn;

afterEach(() => {
  console.warn = originalConsoleWarn;
});

function sessionStateEnvelope(
  backendId: string,
  providerState: Record<string, unknown>,
  exposedPorts?: unknown,
) {
  return {
    version: 1,
    backendId,
    manifest: {},
    workspaceReady: true,
    providerState,
    ...(exposedPorts !== undefined ? { exposedPorts } : {}),
  };
}

function serializedRunStateWithSandbox() {
  const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
  const state = new RunState(new RunContext(), "hello", agent, null);
  const rootProviderState = {
    sandboxId: "sb-root",
    configuredExposedPorts: [3000, 6080],
    providerMarker: "root-kept",
  };
  const childProviderState = {
    sandboxId: "sb-child",
    configuredExposedPorts: [8080],
    providerMarker: "child-kept",
  };
  (state as unknown as { _sandbox: unknown })._sandbox = {
    backendId: "modal",
    currentAgentKey: "root",
    currentAgentName: agent.name,
    sessionState: sessionStateEnvelope("modal", rootProviderState, {
      "3000": { host: "root.example", port: 3000 },
    }),
    sessionsByAgent: {
      root: {
        backendId: "modal",
        currentAgentKey: "root",
        currentAgentName: agent.name,
        sessionState: sessionStateEnvelope("modal", rootProviderState, {
          "3000": { host: "root.example", port: 3000 },
        }),
      },
      handoff: {
        backendId: "modal",
        currentAgentKey: "handoff",
        currentAgentName: "handoff",
        sessionState: sessionStateEnvelope("modal", childProviderState, {
          "8080": { host: "child.example", port: 8080 },
        }),
      },
    },
  };
  return { agent, serializedRunState: state.toString() };
}

describe("RunState exposedPorts compatibility", () => {
  test.each(["modal", "docker", "e2b"])(
    "%s keeps configured port arrays in providerState without lifting them",
    async (backendId) => {
      const client = {
        backendId,
        async serializeSessionState() {
          return {
            instanceId: `${backendId}-instance`,
            manifest: {},
            configuredExposedPorts: [3000, 6080],
            providerMarker: "kept",
          };
        },
      };

      const envelope = await serializeEstablishedSandboxEnvelope({
        client,
        session: {},
        sessionState: { instanceId: `${backendId}-instance` },
        instanceId: `${backendId}-instance`,
        backendId,
      } as never);

      const sessionState = envelope?.sessionState as Record<string, unknown>;
      expect(sessionState.exposedPorts).toBeUndefined();
      expect(sessionState.providerState).toMatchObject({
        configuredExposedPorts: [3000, 6080],
        providerMarker: "kept",
      });
    },
  );

  test("preserves a legitimate native endpoint record in the envelope", async () => {
    const exposedPorts = {
      "3000": { host: "sandbox.example", port: 3000, tls: true },
    };
    const envelope = await serializeEstablishedSandboxEnvelope({
      client: {
        backendId: "modal",
        async serializeSessionState() {
          return {
            sandboxId: "sb-native",
            manifest: {},
            configuredExposedPorts: [3000],
            exposedPorts,
          };
        },
      },
      session: {},
      sessionState: { sandboxId: "sb-native" },
      instanceId: "sb-native",
      backendId: "modal",
    } as never);

    const sessionState = envelope?.sessionState as Record<string, unknown>;
    expect(sessionState.exposedPorts).toEqual(exposedPorts);
    expect(sessionState.exposedPorts).not.toBe(exposedPorts);
    expect(sessionState.providerState).toMatchObject({
      configuredExposedPorts: [3000],
      exposedPorts,
    });
  });

  test("historical lease-envelope arrays are not rehydrated as SDK exposedPorts", async () => {
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    let deserialized: Record<string, unknown> | undefined;
    const client = {
      backendId: "modal",
      async deserializeSessionState(state: Record<string, unknown>) {
        deserialized = state;
        return state;
      },
    };

    await deserializeSandboxSessionStateEnvelope(client as never, {
      providerState: {
        sandboxId: "sb-history",
        configuredExposedPorts: [3000, 6080],
        providerMarker: "kept",
      },
      manifest: {},
      workspaceReady: true,
      exposedPorts: [3000, 6080],
    });

    expect(deserialized).toMatchObject({
      sandboxId: "sb-history",
      configuredExposedPorts: [3000, 6080],
      providerMarker: "kept",
    });
    expect(deserialized?.exposedPorts).toBeUndefined();
    expect(warnings).toEqual([
      [
        "[sandbox] ignored incompatible RunState exposedPorts",
        {
          provider: "modal",
          sessionClass: "root",
          path: "sessionState.exposedPorts",
        },
      ],
    ]);
  });

  test("repairs root and every child/handoff path while preserving provider and RunState state", async () => {
    const { agent, serializedRunState } = serializedRunStateWithSandbox();
    const malformed = JSON.parse(serializedRunState);
    malformed.sandbox.sessionState.exposedPorts = [3000, 6080];
    malformed.sandbox.sessionsByAgent.root.sessionState.exposedPorts = [3000, 6080];
    malformed.sandbox.sessionsByAgent.handoff.sessionState.exposedPorts = [8080];
    malformed.unrelatedCompatibilityMarker = { keep: true };
    const malformedSerialized = JSON.stringify(malformed);

    await expect(RunState.fromString(agent, malformedSerialized)).rejects.toThrow(/exposedPorts/i);

    const repaired = repairSerializedRunStateExposedPorts(malformedSerialized);
    expect(repaired.repairs).toEqual([
      {
        provider: "modal",
        sessionClass: "root",
        path: "sandbox.sessionState.exposedPorts",
      },
      {
        provider: "modal",
        sessionClass: "agent",
        path: "sandbox.sessionsByAgent[*].sessionState.exposedPorts",
      },
    ]);

    const repairedJson = JSON.parse(repaired.serializedRunState);
    expect(repairedJson.sandbox.sessionState.exposedPorts).toBeUndefined();
    expect(repairedJson.sandbox.sessionsByAgent.root.sessionState.exposedPorts).toBeUndefined();
    expect(repairedJson.sandbox.sessionsByAgent.handoff.sessionState.exposedPorts).toBeUndefined();
    expect(repairedJson.sandbox.sessionState.providerState).toMatchObject({
      configuredExposedPorts: [3000, 6080],
      providerMarker: "root-kept",
    });
    expect(repairedJson.sandbox.sessionsByAgent.handoff.sessionState.providerState).toMatchObject({
      configuredExposedPorts: [8080],
      providerMarker: "child-kept",
    });
    expect(repairedJson.unrelatedCompatibilityMarker).toEqual({ keep: true });

    const resumed = await RunState.fromString(agent, repaired.serializedRunState);
    const terminalSerialized = JSON.parse(resumed.toString());
    expect(terminalSerialized.sandbox.sessionState.exposedPorts).toBeUndefined();
    expect(
      terminalSerialized.sandbox.sessionsByAgent.handoff.sessionState.exposedPorts,
    ).toBeUndefined();
    expect(
      terminalSerialized.sandbox.sessionsByAgent.handoff.sessionState.providerState
        .configuredExposedPorts,
    ).toEqual([8080]);
  });

  test("approval resume applies the bounded repair and emits no endpoint values", async () => {
    const { agent, serializedRunState } = serializedRunStateWithSandbox();
    const malformed = JSON.parse(serializedRunState);
    malformed.sandbox.sessionState.exposedPorts = [3000, 6080];
    malformed.sandbox.sessionsByAgent.handoff.sessionState.exposedPorts = [8080];
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);

    await expect(
      prepareRunInput(agent, {
        kind: "approval",
        serializedRunState: JSON.stringify(malformed),
        approvalId: "missing-approval",
        decision: "approve",
      }),
    ).rejects.toThrow(/Interrupted tool not found/);

    expect(warnings).toEqual([
      [
        "[runtime] repaired incompatible RunState exposedPorts",
        {
          errorClass: "RunStateCompatibilityError",
          errorCode: "incompatible_exposed_ports",
          origin: "runtime",
        },
      ],
    ]);
    expect(JSON.stringify(warnings)).not.toContain("3000");
    expect(JSON.stringify(warnings)).not.toContain("6080");
    expect(JSON.stringify(warnings)).not.toContain("8080");
    expect(JSON.stringify(warnings)).not.toContain("sb-root");
    expect(JSON.stringify(warnings)).not.toContain("sb-child");
  });
});
