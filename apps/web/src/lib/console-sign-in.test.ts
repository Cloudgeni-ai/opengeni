import { describe, expect, test } from "bun:test";

import {
  CONSOLE_AUTO_START_COOLDOWN_MS,
  consoleSignedOutStep,
  consoleSignInOutcome,
  consoleSignInReturnFor,
  consoleSignInStartUrl,
  parseConsoleSignInSearch,
} from "./console-sign-in";

const NOW = 1_800_000_000_000;
const step = (search: string, signedOut = false, lastAutoStartedAt: number | null = null) =>
  consoleSignedOutStep({ search, signedOut, lastAutoStartedAt, now: NOW });

describe("Console's signed-out page", () => {
  test("signs in with the app's account right away when nothing says otherwise", () => {
    expect(step("")).toBe("continue");
    expect(step("?org=4f9c2a51-7d3e-4b8a-9c61-2e5f8a7b9d10")).toBe("continue");
    expect(step("", false, NOW - CONSOLE_AUTO_START_COOLDOWN_MS)).toBe("continue");
  });

  test("never signs straight back in: after Sign out, a failed handoff, or one that just ran", () => {
    expect(step("", true)).toBe("choose");
    expect(step("?console_sign_in=failed")).toBe("choose");
    expect(step("", false, NOW - 5_000)).toBe("choose");
  });

  test("shows Console's own sign-in when handoff is unavailable or that sign-in is underway", () => {
    expect(step("?console_sign_in=unavailable")).toBe("fallback");
    expect(step("?error=signup_disabled")).toBe("fallback");
    expect(step("?error=INVALID_TOKEN", true)).toBe("fallback");
    expect(step("?mode=signup")).toBe("fallback");
  });

  test("reads the outcome Console was sent back with", () => {
    expect(consoleSignInOutcome("?console_sign_in=failed")).toBe("failed");
    expect(consoleSignInOutcome("?console_sign_in=unavailable")).toBe("unavailable");
    expect(consoleSignInOutcome("?console_sign_in=other")).toBeNull();
  });

  test("returns to the Console page it was on, with its organization", () => {
    expect(consoleSignInReturnFor("/console/sessions", "?org=abc&console_sign_in=failed")).toBe(
      "/console/sessions?org=abc",
    );
    expect(consoleSignInReturnFor("/", "")).toBe("/console");
    expect(consoleSignInReturnFor("/share/x", "?a=1")).toBe("/console");
    expect(consoleSignInStartUrl("", "/console?org=a b")).toBe(
      "/v1/console-sign-in/start?return=%2Fconsole%3Forg%3Da+b",
    );
  });

  test("the app page takes only text search values", () => {
    expect(
      parseConsoleSignInSearch({ console: "https://c", challenge: "x", return: "/console", y: 1 }),
    ).toEqual({ console: "https://c", challenge: "x", return: "/console" });
    expect(parseConsoleSignInSearch({ console: 5, challenge: "" })).toEqual({});
  });
});
