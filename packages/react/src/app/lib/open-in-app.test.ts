import { describe, expect, test } from "bun:test";

import { isAppOpenablePath, isPhoneAppPlatform, openInAppUrl } from "./open-in-app";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("open in app", () => {
  test("hands the whole page URL to the app", () => {
    const page = "https://app.example.com/workspaces/w1/sessions/s1?at=42";
    const link = openInAppUrl(page);
    expect(link.startsWith("opengeni://open?url=")).toBe(true);
    expect(new URL(link).searchParams.get("url")).toBe(page);
  });

  test("offers the app on phones and iPads, not desktops", () => {
    expect(isPhoneAppPlatform(IPHONE)).toBe(true);
    expect(isPhoneAppPlatform(ANDROID)).toBe(true);
    expect(isPhoneAppPlatform(MAC, 5)).toBe(true); // iPadOS reports a Mac
    expect(isPhoneAppPlatform(MAC, 0)).toBe(false);
    expect(isPhoneAppPlatform(undefined)).toBe(false);
  });

  test("only sessions and workspaces open in the app", () => {
    expect(isAppOpenablePath("/workspaces/w1")).toBe(true);
    expect(isAppOpenablePath("/workspaces/w1/sessions")).toBe(true);
    expect(isAppOpenablePath("/workspaces/w1/sessions/s1")).toBe(true);
    expect(isAppOpenablePath("/sessions/s1")).toBe(true);
    expect(isAppOpenablePath("/workspaces/w1/settings")).toBe(false);
    expect(isAppOpenablePath("/workspaces/w1/inbox")).toBe(false);
    expect(isAppOpenablePath("/workspaces/w1/sessions/s1/files")).toBe(false);
  });
});
