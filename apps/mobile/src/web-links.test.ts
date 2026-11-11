import { expect, mock, test } from "bun:test";

mock.module("react-native", () => ({ Linking: { openURL: async () => true } }));
const { webPaths, webUrl } = await import("./web-links");

test("a chat's copied link is its web address on the deployment", () => {
  const path = webPaths.session("workspace-1", "session-1");
  expect(webUrl("https://agents.example.com", path)).toBe(
    "https://agents.example.com/workspaces/workspace-1/sessions/session-1",
  );
  expect(webUrl("https://agents.example.com/", path)).toBe(
    "https://agents.example.com/workspaces/workspace-1/sessions/session-1",
  );
  expect(webUrl("https://agents.example.com", "settings")).toBe(
    "https://agents.example.com/settings",
  );
});
