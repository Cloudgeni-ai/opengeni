import { describe, expect, test } from "bun:test";

import { desktopAppReturnPath, desktopAppReturnUrl } from "../src/desktop-app";

const console = "https://app.example.com";
const page = "https://app.example.com/workspaces/w1/sessions/s1?tab=a#x";

describe("where a sign-in started in the desktop app returns", () => {
  test("a console page goes through the hand-back page", () => {
    const result = new URL(desktopAppReturnUrl(page, console));
    expect(result.origin).toBe(console);
    expect(result.pathname).toBe("/desktop-return");
    expect(result.searchParams.get("url")).toBe(page);
  });

  test("another site's page, a missing origin and the hand-back page itself stay unchanged", () => {
    expect(desktopAppReturnUrl("https://product.example.test/chat", console)).toBe(
      "https://product.example.test/chat",
    );
    expect(desktopAppReturnUrl(page, null)).toBe(page);
    expect(desktopAppReturnUrl(page, "null")).toBe(page);
    const handBack = desktopAppReturnUrl(page, console);
    expect(desktopAppReturnUrl(handBack, console)).toBe(handBack);
  });
});

describe("where a path-based sign-in started in the desktop app returns", () => {
  test("a console path goes through the hand-back page, keeping room for outcome params", () => {
    const path = "/workspaces/w1/capabilities?connect_item=x#y";
    const result = new URL(desktopAppReturnPath(path), console);
    expect(result.pathname).toBe("/desktop-return");
    expect(result.searchParams.get("url")).toBe(path);
    // What a flow's callback does with it when it finishes.
    result.searchParams.set("integration_oauth", "success");
    expect([...result.searchParams.keys()]).toEqual(["url", "integration_oauth"]);
  });

  test("a non-console path and the hand-back page itself stay unchanged", () => {
    expect(desktopAppReturnPath("//evil.test/x")).toBe("//evil.test/x");
    expect(desktopAppReturnPath("https://evil.test/x")).toBe("https://evil.test/x");
    const handBack = desktopAppReturnPath("/workspaces/w1");
    expect(desktopAppReturnPath(handBack)).toBe(handBack);
  });
});
