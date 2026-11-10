import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  BETTER_AUTH_LOG_TEXT_MAX_BYTES,
  betterAuthLogArgument,
  betterAuthLogArguments,
  betterAuthLogText,
} from "../src/auth/better-auth-log";
import { logBetterAuthMessage } from "../src/auth/managed-auth";

const RESET_TOKEN = "Zx9fQ2mK7vB4nR8tL1pW6sY3hJ5dG0aC";
const RESET_URL = `https://app.example.test/v1/auth/reset-password/${RESET_TOKEN}?callbackURL=%2F`;
const VERIFY_URL = `https://app.example.test/v1/auth/verify-email?token=${RESET_TOKEN}`;

function written(spy: { mock: { calls: unknown[][] } }): string {
  return JSON.stringify(spy.mock.calls);
}

describe("Better Auth log projection", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("drops request bodies and other objects to their kind", () => {
    expect(
      betterAuthLogArgument({ email: "person@example.test", password: "hunter2-hunter2" }),
    ).toBe("[object]");
    expect(betterAuthLogArgument([RESET_URL])).toBe("[array]");
    expect(betterAuthLogArgument(() => RESET_URL)).toBe("[function]");
    expect(betterAuthLogArgument(7)).toBe(7);
    expect(betterAuthLogArgument(false)).toBe(false);
    expect(betterAuthLogArgument(null)).toBeNull();
  });

  test("scrubs tokens, query strings and addresses from text", () => {
    for (const text of [
      `Reset password link: ${RESET_URL}`,
      `Verification link ${VERIFY_URL}`,
      `callback code=abc123def456ghi789jkl012mno345pq state=${RESET_TOKEN}`,
      `token: ${RESET_TOKEN}`,
    ]) {
      const scrubbed = betterAuthLogText(text);
      expect(scrubbed).not.toContain(RESET_TOKEN);
      expect(scrubbed).not.toContain("callbackURL");
    }
    expect(betterAuthLogText("User not found: Person@Example.test")).toBe(
      "User not found: [email]",
    );
    expect(
      new TextEncoder().encode(betterAuthLogText("x".repeat(10_000))).byteLength,
    ).toBeLessThanOrEqual(BETTER_AUTH_LOG_TEXT_MAX_BYTES);
  });

  test("keeps an error's reviewed classification and scrubbed message only", () => {
    const error = new TypeError(`fetch failed for ${VERIFY_URL}`);
    const projected = betterAuthLogArgument(error) as Record<string, unknown>;
    expect(projected.causeName).toBe("TypeError");
    expect(String(projected.causeMessage)).toContain("fetch failed");
    expect(JSON.stringify(projected)).not.toContain(RESET_TOKEN);
    expect(projected).not.toHaveProperty("stack");
  });

  test("bounds the number of logged arguments", () => {
    const projected = betterAuthLogArguments(Array.from({ length: 12 }, (_, index) => index));
    expect(projected).toEqual([0, 1, 2, 3, 4, 5, 6, 7, "[4 more]"]);
  });

  test("the managed auth logger never writes raw arguments", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    spies.push(error, warn, log);

    logBetterAuthMessage("error", `Failed to send reset email ${RESET_URL}`, {
      email: "person@example.test",
      password: "hunter2-hunter2",
    });
    logBetterAuthMessage("warn", "Verification", VERIFY_URL);
    logBetterAuthMessage("info", "Signed in", { user: { email: "person@example.test" } });

    for (const spy of [error, warn, log]) {
      expect(spy).toHaveBeenCalledTimes(1);
      const output = written(spy);
      expect(output).not.toContain(RESET_TOKEN);
      expect(output).not.toContain("person@example.test");
      expect(output).not.toContain("hunter2");
      expect(output).toContain("[Better Auth]");
    }
  });
});
