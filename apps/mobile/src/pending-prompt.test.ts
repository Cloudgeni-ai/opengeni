import { expect, test } from "bun:test";
import { forgetPendingPrompt, readPendingPrompt, rememberPendingPrompt } from "./pending-prompt";

test("first-message handoff is scoped to the account client, workspace and chat", () => {
  const client = {},
    other = {};
  const prompt = { text: "Help plan my week", sentAt: "2026-10-29T10:00:00Z" };
  rememberPendingPrompt(client, "work", "chat", prompt);
  expect(readPendingPrompt(client, "work", "chat")).toBe(prompt);
  expect(readPendingPrompt(other, "work", "chat")).toBeNull();
  expect(readPendingPrompt(client, "other", "chat")).toBeNull();
  expect(readPendingPrompt(client, "work", "other")).toBeNull();
  forgetPendingPrompt(client, "work", "chat");
  expect(readPendingPrompt(client, "work", "chat")).toBeNull();
});
