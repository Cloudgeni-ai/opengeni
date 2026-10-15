import { describe, expect, test } from "bun:test";

import { macLoginAgentName, macLoginAgentPlist } from "../src/main/mac-login-agent";

function strings(plist: string, key: string): string[] {
  const match = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`, "u").exec(plist);
  return [...(match?.[1] ?? "").matchAll(/<string>(.*?)<\/string>/gu)].map((found) => found[1]!);
}

describe("the macOS login agent", () => {
  const plist = macLoginAgentPlist("ai.example.desktop");

  test("opens the app by its bundle identifier, in the background and hidden", () => {
    expect(strings(plist, "ProgramArguments")).toEqual([
      "/usr/bin/open",
      "-g",
      "-b",
      "ai.example.desktop",
      "--args",
      "--hidden",
    ]);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(strings(plist, "AssociatedBundleIdentifiers")).toEqual(["ai.example.desktop"]);
  });

  test("has its own label and runs once, so unregistering it never stops the app", () => {
    expect(plist).toContain("<string>ai.example.desktop.open-at-login</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(macLoginAgentName("ai.example.desktop")).toBe("ai.example.desktop.open-at-login.plist");
  });

  test("escapes identifiers for XML", () => {
    expect(macLoginAgentPlist("a&b")).toContain("<string>a&amp;b</string>");
  });
});
