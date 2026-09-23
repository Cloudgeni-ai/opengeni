import { expect, test } from "bun:test";
import {
  MANAGED_BROWSER_SESSION_CAPABILITIES,
  readStoredBrowserCapabilities,
} from "../src/browser-sessions";

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
