// The macOS app declares only the privacy permissions a shipped feature uses.
// A usage description or entitlement nothing uses makes people wonder what the
// app wants, and the System Settings lists show the app where it does not belong.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

type MacConfig = {
  extendInfo?: Record<string, unknown>;
  entitlements?: string;
  entitlementsInherit?: string;
};

function macConfig(): MacConfig {
  const config = Bun.YAML.parse(readFileSync(join(root, "electron-builder.yml"), "utf8")) as {
    mac?: MacConfig;
  };
  return config.mac ?? {};
}

function entitlementKeys(path: string): string[] {
  const body = readFileSync(join(root, path), "utf8");
  return [...body.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/gu)].map((match) => match[1]!);
}

/** Usage descriptions Electron's own Info.plist declares (Electron 44). */
const ELECTRON_DEFAULT_USAGE_KEYS = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

/**
 * The microphone (dictation, voice chats, meeting recordings) and system-audio
 * recording (a meeting recording that includes the computer's audio).
 */
const KEPT_USAGE_KEYS = ["NSAudioCaptureUsageDescription", "NSMicrophoneUsageDescription"];

describe("macOS privacy declarations", () => {
  test("the app describes only the microphone and system-audio recording", () => {
    const info = macConfig().extendInfo ?? {};
    const usage = Object.entries(info).filter(([key]) => /^NS\w+UsageDescription$/u.test(key));
    const kept = usage.filter(([, value]) => value !== null).map(([key]) => key);
    expect(kept.sort()).toEqual(KEPT_USAGE_KEYS);
    expect(info.NSMicrophoneUsageDescription).toMatch(/dictate/u);
    expect(info.NSAudioCaptureUsageDescription).toMatch(/meeting recording/u);
  });

  test("every usage description Electron ships is either kept on purpose or removed", () => {
    // electron-builder deletes an Info.plist key whose extendInfo value is null.
    const info = macConfig().extendInfo ?? {};
    for (const key of ELECTRON_DEFAULT_USAGE_KEYS) expect(Object.hasOwn(info, key)).toBe(true);
    const removed = ELECTRON_DEFAULT_USAGE_KEYS.filter((name) => !KEPT_USAGE_KEYS.includes(name));
    for (const key of removed) expect(info[key]).toBeNull();
  });

  test("no automation or other-app access is declared", () => {
    const info = macConfig().extendInfo ?? {};
    expect(Object.hasOwn(info, "NSAppleEventsUsageDescription")).toBe(false);
  });

  test("the app and its helpers are entitled to JIT and the microphone only", () => {
    const mac = macConfig();
    expect(mac.entitlements).toBe("resources/entitlements.mac.plist");
    expect(mac.entitlementsInherit).toBe("resources/entitlements.mac.plist");
    expect(entitlementKeys(mac.entitlements!).sort()).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.device.audio-input",
    ]);
  });
});
