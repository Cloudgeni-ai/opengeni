import { describe, expect, test } from "bun:test";

import { macLoginAgentName, macLoginAgentPlist } from "../src/main/mac-login-agent";

function strings(plist: string, key: string): string[] {
  const match = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`, "u").exec(plist);
  return [...(match?.[1] ?? "").matchAll(/<string>(.*?)<\/string>/gu)].map((found) => found[1]!);
}

describe("the macOS login agent", () => {
  const plist = macLoginAgentPlist("ai.example.desktop");

  test("opens the app by its bundle identifier, in the background and hidden", () => {
    const [shell, flag, command, bundleId] = strings(plist, "ProgramArguments");
    expect([shell, flag, bundleId]).toEqual(["/bin/sh", "-c", "ai.example.desktop"]);
    expect(command).toContain('exec /usr/bin/open -g -b "$0" --args --hidden');
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(strings(plist, "AssociatedBundleIdentifiers")).toEqual(["ai.example.desktop"]);
  });

  test("waits for macOS to reopen apps, then leaves a running app alone", () => {
    const command = strings(plist, "ProgramArguments")[2]!;
    expect(command).toStartWith("sleep 5; ");
    expect(command).toContain(
      '/usr/bin/lsappinfo find bundleid="$0" | /usr/bin/grep -q ASN || exec',
    );
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
