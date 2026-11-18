import { describe, expect, test } from "bun:test";

import {
  desktopAppReturnPath,
  desktopAppReturnUrl,
  oauthSignInToFinishPath,
  oauthSignInToFinishTarget,
} from "../src/desktop-app";

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

describe("a desktop sign-in that returns to a signed-out browser signs in, then finishes", () => {
  const callback = "/v1/integrations/oauth/callback?code=c1&state=s1";

  test("the console page carries the exact server step, and resumes it", () => {
    const path = oauthSignInToFinishPath(`https://api.internal:8000${callback}`);
    const continueUrl = new URL(path, console);
    expect(continueUrl.pathname).toBe("/connect-continue");
    expect(oauthSignInToFinishTarget(continueUrl.search, console)).toBe(`${console}${callback}`);
  });

  test("only the OAuth callbacks and the Nango connect page can be resumed", () => {
    for (const step of [
      "/v1/integrations/provider-oauth/callback?code=c&state=s",
      "/v1/integrations/nango/connect?state=s",
    ])
      expect(oauthSignInToFinishTarget(`?next=${encodeURIComponent(step)}`, console)).toBe(
        `${console}${step}`,
      );
    for (const next of [
      "https://evil.test/v1/integrations/oauth/callback",
      "//evil.test/v1/integrations/oauth/callback",
      "/\\evil.test/v1/integrations/oauth/callback",
      "/workspaces/w1/plugins",
      "/v1/integrations/oauth/callbackx",
      "javascript:alert(1)",
    ])
      expect(oauthSignInToFinishTarget(`?next=${encodeURIComponent(next)}`, console)).toBe(null);
    expect(oauthSignInToFinishTarget("", console)).toBe(null);
  });
});
