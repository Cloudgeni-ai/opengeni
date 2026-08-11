import { describe, expect, test } from "bun:test";
import {
  attachedTab,
  browserProduct,
  extensionArchitecture,
  extensionPlatform,
  parseExtensionCommand,
  parseExtensionReady,
  tabUnavailableReason,
} from "../src/protocol";

describe("attached browser extension protocol", () => {
  test("projects ordinary tabs and marks Chrome-owned pages unavailable", () => {
    expect(
      attachedTab({
        id: 7,
        windowId: 2,
        index: 1,
        title: "OpenGeni",
        url: "https://opengeni.ai/",
        active: true,
        pinned: false,
        incognito: false,
        highlighted: true,
        selected: true,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
        frozen: false,
      }),
    ).toEqual(
      expect.objectContaining({
        id: "7",
        url: "https://opengeni.ai/",
        controllable: true,
        unavailableReason: null,
      }),
    );
    expect(tabUnavailableReason("chrome://settings/")).toContain("browser page");
    expect(tabUnavailableReason("https://chromewebstore.google.com/detail/x")).toContain(
      "Web Store",
    );
    expect(
      attachedTab({
        id: 8,
        windowId: 2,
        index: 2,
        title: "Loading",
        url: "",
        pendingUrl: "https://opengeni.ai/loading",
        active: false,
        pinned: false,
        incognito: false,
        highlighted: false,
        selected: false,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
        frozen: false,
      })?.url,
    ).toBe("https://opengeni.ai/loading");
  });

  test("normalizes supported host platforms without guessing unsupported ones", () => {
    expect(extensionPlatform({ os: "mac", arch: "arm", nacl_arch: "arm" })).toBe("macos");
    expect(extensionArchitecture({ os: "mac", arch: "arm64", nacl_arch: "arm" })).toBe("arm64");
    expect(extensionArchitecture({ os: "linux", arch: "x86-64", nacl_arch: "x86-64" })).toBe("x64");
    expect(() =>
      extensionArchitecture({ os: "linux", arch: "x86-32", nacl_arch: "x86-32" }),
    ).toThrow("Unsupported browser architecture");
  });

  test("reports the concrete Chrome product version", () => {
    expect(
      browserProduct(
        "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/151.0.8123.1 Safari/537.36",
      ),
    ).toEqual({ name: "Chrome", version: "151.0.8123.1" });
  });

  test("parses one exact generation-fenced debugger command", () => {
    expect(
      parseExtensionCommand({
        type: "command",
        protocolVersion: 1,
        requestId: "11111111-1111-4111-8111-111111111111",
        deviceId: "22222222-2222-4222-8222-222222222222",
        connectionGeneration: "generation-1",
        payload: {
          type: "debugger.command",
          tabId: "7",
          method: "Page.navigate",
          params: { url: "https://opengeni.ai/" },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "debugger.command",
          tabId: "7",
          method: "Page.navigate",
        }),
      }),
    );
    expect(() =>
      parseExtensionCommand({
        type: "command",
        protocolVersion: 1,
        requestId: "11111111-1111-4111-8111-111111111111",
        deviceId: "22222222-2222-4222-8222-222222222222",
        connectionGeneration: "generation-1",
        payload: { type: "debugger.poll", afterSequence: 0, limit: 1, surprise: true },
      }),
    ).toThrow("unknown fields");
  });

  test("accepts readiness only for one exact profile fence", () => {
    expect(
      parseExtensionReady({
        type: "ready",
        protocolVersion: 1,
        deviceId: "22222222-2222-4222-8222-222222222222",
        connectionGeneration: "generation-1",
      }),
    ).toEqual({
      type: "ready",
      protocolVersion: 1,
      deviceId: "22222222-2222-4222-8222-222222222222",
      connectionGeneration: "generation-1",
    });
    expect(() =>
      parseExtensionReady({
        type: "ready",
        protocolVersion: 1,
        deviceId: "22222222-2222-4222-8222-222222222222",
        connectionGeneration: "generation-1",
        extra: true,
      }),
    ).toThrow("unknown fields");
  });
});
