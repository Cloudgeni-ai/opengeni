import { expect, test } from "bun:test";
import { inAppLinkPath } from "./in-app-link";

const origin = "https://app.example.com";
const hasPage = (pathname: string) => pathname.startsWith("/workspaces");

test("a link to a page of this Opengeni opens in place", () => {
  expect(inAppLinkPath("https://app.example.com/workspaces/w/agents/a", origin, hasPage)).toBe(
    "/workspaces/w/agents/a",
  );
  expect(
    inAppLinkPath("https://app.example.com/workspaces/w/automations?x=1#top", origin, hasPage),
  ).toBe("/workspaces/w/automations?x=1#top");
});

test("an outside link, another port or an invalid address stays outside", () => {
  expect(inAppLinkPath("https://docs.example.com/guide", origin, hasPage)).toBeNull();
  expect(inAppLinkPath("https://app.example.com:8443/workspaces", origin, hasPage)).toBeNull();
  expect(inAppLinkPath("http://app.example.com/workspaces", origin, hasPage)).toBeNull();
  expect(inAppLinkPath("not a url", origin, hasPage)).toBeNull();
});

test("a same-origin path the app has no page for loads from the server", () => {
  expect(inAppLinkPath("https://app.example.com/v1/files/f/download", origin, hasPage)).toBeNull();
});
