import { describe, expect, test } from "bun:test";
import { nativeCallTitle } from "../src/realtime/call-title";

const id = "5cab6202-1dcd-4c3e-9a7b-0f1e2d3c4b5a";

describe("nativeCallTitle", () => {
  test("uses the untitled label before the session has loaded", () => {
    expect(nativeCallTitle(null, "New call")).toBe("New call");
  });

  test("never shows an ID-derived reference for a brand-new session", () => {
    expect(nativeCallTitle({ id, title: null }, "New call")).toBe("New call");
    expect(nativeCallTitle({ id, title: "", titleSource: "user" }, "New call")).toBe("New call");
  });

  test("keeps a real title", () => {
    expect(nativeCallTitle({ id, title: "Release plan", titleSource: "agent" }, "New call")).toBe(
      "Release plan",
    );
    expect(nativeCallTitle({ id, title: "Mine", titleSource: "user" }, "New call")).toBe("Mine");
  });

  test("falls back to the opening prompt preview", () => {
    expect(nativeCallTitle({ id, initialMessage: "Check the deploy" }, "New call")).toBe(
      "Check the deploy",
    );
  });
});
