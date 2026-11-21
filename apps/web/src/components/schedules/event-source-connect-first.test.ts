import { expect, test } from "bun:test";

import { connectGitHubHref, githubConnectedFromStatus } from "./event-source-connect-first";

test("a GitHub source asks to connect GitHub only when the workspace can and hasn't", () => {
  expect(githubConnectedFromStatus("bound")).toBe(true);
  expect(githubConnectedFromStatus("unbound")).toBe(false);
  // No GitHub App on this server: adding the source explains that instead.
  expect(githubConnectedFromStatus("disabled")).toBeNull();
});

test("Connect GitHub opens the workspace's GitHub connection", () => {
  expect(connectGitHubHref("ws 1")).toBe("/workspaces/ws%201/plugins?open=integration:github");
});
