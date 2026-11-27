import { expect, mock, test } from "bun:test";

const opened: string[] = [];
mock.module("react-native", () => ({
  Linking: {
    openURL: async (url: string) => {
      opened.push(url);
      return true;
    },
  },
  Platform: { OS: "ios" },
}));
const { hostedUrl, markHostedUrl, openOnWeb, webPaths, webUrl } = await import("./web-links");

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

test("pages the iOS app opens on its deployment say client=ios, keeping their query and hash", () => {
  expect(hostedUrl("https://agents.example.com/", webPaths.security(), "ios")).toBe(
    "https://agents.example.com/settings/security?client=ios",
  );
  expect(hostedUrl("https://agents.example.com", webPaths.home(), "ios")).toBe(
    "https://agents.example.com/?client=ios",
  );
  expect(hostedUrl("https://agents.example.com", webPaths.organizationMembers("w 1"), "ios")).toBe(
    "https://agents.example.com/workspaces/w%201/organization?section=people&client=ios",
  );
  expect(
    markHostedUrl("https://agents.example.com/native-view/a?page=%2Fx%2Fy&q=a+b#top/part", "ios"),
  ).toBe("https://agents.example.com/native-view/a?page=%2Fx%2Fy&q=a+b&client=ios#top/part");
  // Set, never duplicated: a page that already says so keeps one marker.
  expect(markHostedUrl("https://agents.example.com/?client=ios", "ios")).toBe(
    "https://agents.example.com/?client=ios",
  );
  expect(markHostedUrl("https://agents.example.com/?client=web", "ios")).toBe(
    "https://agents.example.com/?client=ios",
  );
});

test("the marker is iOS only and never touches the shared or API address", () => {
  expect(hostedUrl("https://agents.example.com", webPaths.security(), "android")).toBe(
    "https://agents.example.com/settings/security",
  );
  // The plain builder stays plain: copied links and the app's own API calls use it.
  expect(webUrl("https://agents.example.com", "/v1/native-app/web-session")).toBe(
    "https://agents.example.com/v1/native-app/web-session",
  );
  expect(markHostedUrl("not a url", "ios")).toBe("not a url");
});

test("Open on the web opens the marked page", () => {
  opened.length = 0;
  openOnWeb("https://agents.example.com", webPaths.organizationSettings("w1"));
  expect(opened).toEqual(["https://agents.example.com/workspaces/w1/organization?client=ios"]);
});
