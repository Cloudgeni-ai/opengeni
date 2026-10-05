import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ComputerNativeClient, ComputerBackendError } from "../src";

describe("ComputerNativeClient", () => {
  test("negotiates click continuation explicitly and keeps older helpers unsupported", async () => {
    for (const supported of [false, true]) {
      const client = await ComputerNativeClient.open({
        binaryPath: process.execPath,
        arguments: [
          resolve(import.meta.dir, "fixtures/computer-native-fixture.ts"),
          ...(supported ? ["--click-continuation"] : []),
        ],
      });
      try {
        expect(client.initialCapabilities.pointerClickContinuation === true).toBe(supported);
        expect((await client.capabilities()).pointerClickContinuation === true).toBe(supported);
      } finally {
        await client.close();
      }
    }
    await expect(
      ComputerNativeClient.open({
        binaryPath: process.execPath,
        arguments: [
          resolve(import.meta.dir, "fixtures/computer-native-fixture.ts"),
          "--malformed-click-continuation",
        ],
      }),
    ).rejects.toMatchObject({
      name: "UnsettledCleanupError",
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("pointerClickContinuation"),
        }),
      ]),
    });
  });

  test("correlates out-of-order responses, binary captures, and typed adapter errors", async () => {
    const client = await ComputerNativeClient.open({
      binaryPath: process.execPath,
      arguments: [resolve(import.meta.dir, "fixtures/computer-native-fixture.ts")],
    });
    try {
      expect(client.handshake).toMatchObject({
        protocolVersion: 3,
        helperVersion: "fixture-1",
        platform: "linux",
      });
      const [targets, capabilities] = await Promise.all([client.targets(), client.capabilities()]);
      expect(targets[0]).toMatchObject({ id: "window-1", targetGeneration: "target-generation-1" });
      expect(capabilities.parallelApps).toBe(true);
      expect(await client.clipboard()).toEqual({ text: "fixture clipboard", truncated: false });
      const frame = await client.captureStill("window-1", {
        format: "png",
        quality: 75,
        maxWidth: 1024,
        maxHeight: 768,
      });
      expect(new TextDecoder().decode(frame.data)).toBe("fixture-png");
      expect(frame).toMatchObject({ frameId: "frame-1", width: 10, height: 20 });
      await expect(client.observe("missing")).rejects.toMatchObject({
        name: "ComputerBackendError",
        code: "target_not_found",
        retryable: false,
        dispatched: false,
      } satisfies Partial<ComputerBackendError>);
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
      await expect(client.close()).rejects.toThrow("cleanup was not confirmed");
      await expect(client.close()).rejects.toThrow("cleanup was not confirmed");
    }
  });

  test("times out and terminates a stalled binary attachment", async () => {
    const client = await openFixture({ captureTimeoutMs: 100 });
    try {
      await expect(client.capture("stalled")).rejects.toThrow("capture timed out");
      await expect(client.targets()).rejects.toThrow("attachment timed out");
    } finally {
      await expect(client.close()).rejects.toThrow("cleanup was not confirmed");
    }
  });

  test.each(["--nonzero-eof", "--ignore-eof"])(
    "retains unconfirmed native process cleanup on repeat close (%s)",
    async (flag) => {
      const client = await ComputerNativeClient.open({
        binaryPath: process.execPath,
        arguments: [resolve(import.meta.dir, "fixtures/computer-native-fixture.ts"), flag],
      });
      await expect(client.close()).rejects.toMatchObject({ name: "UnsettledCleanupError" });
      await expect(client.close()).rejects.toMatchObject({ name: "UnsettledCleanupError" });
    },
    12_000,
  );
});

async function openFixture(options: { captureTimeoutMs?: number } = {}) {
  return await ComputerNativeClient.open({
    binaryPath: process.execPath,
    arguments: [resolve(import.meta.dir, "fixtures/computer-native-fixture.ts")],
    ...options,
  });
}
