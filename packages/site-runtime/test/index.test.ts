import { describe, expect, test } from "bun:test";
import { connect, type SiteRuntime } from "../src";

describe("@opengeni/site-runtime", () => {
  test("uses only the shell-injected bridge", async () => {
    const runtime = {
      ai: {
        start: async () => ({
          runtimeSession: { id: "runtime" },
          sessionId: "session",
          eventsPath: "/events",
        }),
        send: async () => ({}),
        cancel: async () => ({}),
      },
      onEvent: () => () => undefined,
    } satisfies SiteRuntime;
    Object.defineProperty(globalThis, "OpenGeniSite", {
      configurable: true,
      value: { connect: async () => runtime },
    });
    try {
      expect(await connect()).toBe(runtime);
    } finally {
      delete (globalThis as typeof globalThis & { OpenGeniSite?: unknown }).OpenGeniSite;
    }
  });
});
