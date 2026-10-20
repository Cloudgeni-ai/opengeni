import { describe, expect, test } from "bun:test";

import { desktopReturnAppLink, desktopReturnTarget } from "./desktop-return";

const origin = "https://app.example.com";
const page = `${origin}/workspaces/w1/sessions/s1`;

describe("desktop hand-back page", () => {
  test("returns to the console page the flow started from", () => {
    expect(desktopReturnTarget(`?url=${encodeURIComponent(page)}`, origin)).toBe(page);
  });

  test("carries a provider's outcome parameters onto that page", () => {
    expect(
      desktopReturnTarget(`?url=${encodeURIComponent(`${page}?tab=x`)}&status=connected`, origin),
    ).toBe(`${page}?tab=x&status=connected`);
  });

  test("never sends the person to another site", () => {
    expect(desktopReturnTarget(`?url=${encodeURIComponent("https://evil.test/")}`, origin)).toBe(
      null,
    );
    expect(desktopReturnTarget(`?url=${encodeURIComponent("//evil.test/x")}`, origin)).toBe(null);
    expect(desktopReturnTarget("?url=javascript%3Aalert(1)", origin)).toBe(null);
    expect(desktopReturnTarget("", origin)).toBe(null);
  });

  test("returns to a console path with the outcome a flow added", () => {
    expect(
      desktopReturnTarget(
        `?url=${encodeURIComponent("/workspaces/w1/capabilities?connect_item=x")}&integration_oauth=success`,
        origin,
      ),
    ).toBe(`${origin}/workspaces/w1/capabilities?connect_item=x&integration_oauth=success`);
  });

  test("opens the page in the app through its link", () => {
    expect(desktopReturnAppLink(page)).toBe(`opengeni://open?url=${encodeURIComponent(page)}`);
  });
});
