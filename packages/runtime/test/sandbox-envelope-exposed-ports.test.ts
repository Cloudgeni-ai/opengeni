import { describe, expect, test } from "bun:test";
import { Manifest } from "@openai/agents-core/sandbox";
import { serializeEstablishedSandboxEnvelope } from "../src";

describe("RunState exposedPorts in the sandbox envelope", () => {
  test.each(["modal", "docker", "e2b"])(
    "%s keeps configured port arrays in providerState without lifting them",
    async (backendId) => {
      const instanceId = `${backendId}-instance`;
      const providerIdentity =
        backendId === "docker" ? { containerId: instanceId } : { sandboxId: instanceId };
      const client = {
        backendId,
        async serializeSessionState() {
          return {
            ...providerIdentity,
            manifest: {},
            configuredExposedPorts: [3000, 6080],
            providerMarker: "kept",
          };
        },
      };

      const envelope = await serializeEstablishedSandboxEnvelope({
        client,
        session: {},
        sessionState: providerIdentity,
        instanceId,
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

  test("serializes a live SDK Manifest once at the envelope boundary", async () => {
    const manifest = new Manifest({
      root: "/workspace",
      entries: {},
      environment: { TEST_VALUE: "manifest-ok" },
    });
    const envelope = await serializeEstablishedSandboxEnvelope({
      client: {
        backendId: "docker",
        async serializeSessionState() {
          return {
            containerId: "container-manifest",
            manifest,
          };
        },
      },
      session: {},
      sessionState: { containerId: "container-manifest" },
      instanceId: "container-manifest",
      backendId: "docker",
    } as never);

    const sessionState = envelope?.sessionState as Record<string, unknown>;
    expect(sessionState.manifest).toMatchObject({
      version: 1,
      root: "/workspace",
      entries: {},
      environment: { TEST_VALUE: { value: "manifest-ok" } },
    });
    expect(sessionState.manifest).not.toBe(manifest);
    expect(sessionState.providerState).toEqual({ containerId: "container-manifest" });
  });
});
