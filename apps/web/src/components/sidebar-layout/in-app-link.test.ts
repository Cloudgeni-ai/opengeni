import { expect, test } from "bun:test";
import { inAppLinkPath } from "./in-app-link";

const origin = "https://app.example.com";

test("a link to a page of this Opengeni opens in place", () => {
  expect(inAppLinkPath("https://app.example.com/workspaces/w/agents/a", origin)).toBe(
    "/workspaces/w/agents/a",
  );
  expect(inAppLinkPath("https://app.example.com/workspaces/w/automations?x=1#top", origin)).toBe(
    "/workspaces/w/automations?x=1#top",
  );
});

test("an outside link, another port or an invalid address stays outside", () => {
  expect(inAppLinkPath("https://docs.example.com/guide", origin)).toBeNull();
  expect(inAppLinkPath("https://app.example.com:8443/workspaces", origin)).toBeNull();
  expect(inAppLinkPath("http://app.example.com/workspaces", origin)).toBeNull();
  expect(inAppLinkPath("not a url", origin)).toBeNull();
});
