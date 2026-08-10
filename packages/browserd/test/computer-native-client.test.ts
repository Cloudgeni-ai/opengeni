import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ComputerNativeClient, NativeComputerError } from "../src";

describe("ComputerNativeClient", () => {
  test("correlates out-of-order responses, binary captures, and typed adapter errors", async () => {
    const client = await ComputerNativeClient.open({
      binaryPath: process.execPath,
      arguments: [resolve(import.meta.dir, "fixtures/computer-native-fixture.ts")],
    });
    try {
      expect(client.handshake).toMatchObject({
        protocolVersion: 1,
        helperVersion: "fixture-1",
        platform: "linux",
      });
      const [targets, capabilities] = await Promise.all([client.targets(), client.capabilities()]);
      expect(targets[0]).toMatchObject({ id: "window-1", targetGeneration: "target-generation-1" });
      expect(capabilities.parallelApps).toBe(true);
      const frame = await client.capture("window-1");
      expect(new TextDecoder().decode(frame.data)).toBe("fixture-png");
      expect(frame).toMatchObject({ frameId: "frame-1", width: 10, height: 20 });
      await expect(client.observe("missing")).rejects.toMatchObject({
        name: "NativeComputerError",
        code: "target_not_found",
        retryable: false,
        dispatched: false,
      } satisfies Partial<NativeComputerError>);
    } finally {
      await client.close();
    }
  });

  test("rejects malformed responses without orphaning the request", async () => {
    const client = await openFixture();
    try {
      await expect(client.observe("malformed")).rejects.toThrow("native observation");
      await expect(client.targets()).rejects.toThrow("native observation");
    } finally {
      await client.close();
    }
  });

  test("times out and terminates a stalled binary attachment", async () => {
    const client = await openFixture({ captureTimeoutMs: 100 });
    try {
      await expect(client.capture("stalled")).rejects.toThrow("capture timed out");
      await expect(client.targets()).rejects.toThrow("attachment timed out");
    } finally {
      await client.close();
    }
  });
});

async function openFixture(options: { captureTimeoutMs?: number } = {}) {
  return await ComputerNativeClient.open({
    binaryPath: process.execPath,
    arguments: [resolve(import.meta.dir, "fixtures/computer-native-fixture.ts")],
    ...options,
  });
}
