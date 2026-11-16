import { describe, expect, test } from "bun:test";

import { consoleSignInReturnPath, isConsoleHostname } from "../src/console-sign-in";

describe("Console sign-in handoff contract", () => {
  test("Console hosts are console.* and *.console.*, nothing else", () => {
    expect(isConsoleHostname("console.opengeni.ai")).toBe(true);
    expect(isConsoleHostname("staging.console.opengeni.ai")).toBe(true);
    expect(isConsoleHostname("Console.Opengeni.AI.")).toBe(true);
    expect(isConsoleHostname("app.opengeni.ai")).toBe(false);
    expect(isConsoleHostname("consolex.opengeni.ai")).toBe(false);
    expect(isConsoleHostname("console")).toBe(false);
    expect(isConsoleHostname("a.b.console.opengeni.ai")).toBe(false);
  });

  test("a return path keeps the Console page and its query, organization included", () => {
    const org = "4f9c2a51-7d3e-4b8a-9c61-2e5f8a7b9d10";
    expect(consoleSignInReturnPath("/console")).toBe("/console");
    expect(consoleSignInReturnPath(`/console/sessions?org=${org}&workspace=x`)).toBe(
      `/console/sessions?org=${org}&workspace=x`,
    );
    expect(consoleSignInReturnPath(`/console?org=${org}#top`)).toBe(`/console?org=${org}`);
    // A previous attempt's outcome isn't carried back.
    expect(consoleSignInReturnPath(`/console/usage?console_sign_in=failed&org=${org}`)).toBe(
      `/console/usage?org=${org}`,
    );
  });

  test("anything that could leave Console returns Overview", () => {
    for (const unsafe of [
      undefined,
      null,
      42,
      "",
      "console",
      "https://evil.test/console",
      "//evil.test/console",
      "///evil.test",
      "/\\evil.test/console",
      "/console\\..\\x",
      "/console//evil.test",
      "/console/../workspaces",
      "/console/%2e%2e/workspaces",
      "/consolex",
      "/settings",
      "/console\u0000",
      "/console\n/x",
      "javascript:alert(1)",
      `/console/${"a".repeat(2_100)}`,
    ]) {
      expect(consoleSignInReturnPath(unsafe)).toBe("/console");
    }
  });
});
