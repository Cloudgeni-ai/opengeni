import { describe, expect, test } from "bun:test";

import { grantsPermissionCheck, grantsPermissionRequest } from "../src/main/web-permissions";

describe("what the account's page may ask for", () => {
  test("the microphone, for dictation and voice chats", () => {
    expect(grantsPermissionRequest(true, "media", { mediaTypes: ["audio"] })).toBe(true);
  });

  test("never the camera, alone or with the microphone", () => {
    expect(grantsPermissionRequest(true, "media", { mediaTypes: ["video"] })).toBe(false);
    expect(grantsPermissionRequest(true, "media", { mediaTypes: ["audio", "video"] })).toBe(false);
  });

  test("a media request that names no device is refused", () => {
    expect(grantsPermissionRequest(true, "media", { mediaTypes: [] })).toBe(false);
    expect(grantsPermissionRequest(true, "media")).toBe(false);
  });

  test("the clipboard, full screen and pointer lock", () => {
    for (const permission of [
      "clipboard-sanitized-write",
      "clipboard-read",
      "fullscreen",
      "pointerLock",
    ]) {
      expect(grantsPermissionRequest(true, permission)).toBe(true);
    }
  });

  test("nothing that would make macOS ask about another privacy permission", () => {
    for (const permission of [
      "geolocation",
      "display-capture",
      "notifications",
      "midi",
      "midiSysex",
      "hid",
      "serial",
      "usb",
      "idle-detection",
      "speaker-selection",
      "window-management",
      "openExternal",
      "fileSystem",
      "unknown",
    ]) {
      expect(grantsPermissionRequest(true, permission)).toBe(false);
    }
  });

  test("another page gets nothing", () => {
    expect(grantsPermissionRequest(false, "media", { mediaTypes: ["audio"] })).toBe(false);
    expect(grantsPermissionRequest(false, "clipboard-read")).toBe(false);
  });
});

describe("what the account's page is told it has", () => {
  test("the microphone, but not the camera", () => {
    expect(grantsPermissionCheck(true, "media", { mediaType: "audio" })).toBe(true);
    expect(grantsPermissionCheck(true, "media", { mediaType: "unknown" })).toBe(true);
    expect(grantsPermissionCheck(true, "media", { mediaType: "video" })).toBe(false);
  });

  test("the clipboard and full screen, and nothing else", () => {
    expect(grantsPermissionCheck(true, "clipboard-read")).toBe(true);
    expect(grantsPermissionCheck(true, "fullscreen")).toBe(true);
    expect(grantsPermissionCheck(true, "geolocation")).toBe(false);
    expect(grantsPermissionCheck(true, "hid")).toBe(false);
  });

  test("another origin is told nothing", () => {
    expect(grantsPermissionCheck(false, "media", { mediaType: "audio" })).toBe(false);
  });
});
