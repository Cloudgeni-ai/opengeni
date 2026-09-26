import { expect, test } from "bun:test";
import {
  LIGHTPANDA_BROWSER_SESSION_CAPABILITIES,
  MANAGED_BROWSER_SESSION_CAPABILITIES,
  readStoredBrowserCapabilities,
} from "../src/browser-sessions";

test("Lightpanda never advertises placeholder screenshots, including stored legacy sessions", () => {
  expect(LIGHTPANDA_BROWSER_SESSION_CAPABILITIES.screenshots).toBe(false);
  const legacy = { ...LIGHTPANDA_BROWSER_SESSION_CAPABILITIES, screenshots: true };
  expect(readStoredBrowserCapabilities(legacy, "lightpanda")).toEqual({
    ...legacy,
    screenshots: false,
  });
  expect(readStoredBrowserCapabilities(MANAGED_BROWSER_SESSION_CAPABILITIES, "chromium")).toEqual(
    MANAGED_BROWSER_SESSION_CAPABILITIES,
  );
});

test("legacy browser capabilities remain readable without granting permission control", () => {
  const { permissions: _permissions, ...legacy } = MANAGED_BROWSER_SESSION_CAPABILITIES;
  expect(readStoredBrowserCapabilities(legacy)).toEqual({ ...legacy, permissions: false });
  expect(readStoredBrowserCapabilities(MANAGED_BROWSER_SESSION_CAPABILITIES).permissions).toBe(
    true,
  );
  expect(() => readStoredBrowserCapabilities({ ...legacy, permissions: "true" })).toThrow();
  expect(() => readStoredBrowserCapabilities({ ...legacy, permissions: null })).toThrow();
  expect(() => readStoredBrowserCapabilities({ permissions: false })).toThrow();
});
