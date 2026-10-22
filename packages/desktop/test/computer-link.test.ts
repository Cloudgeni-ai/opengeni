import { expect, test, mock } from "bun:test";
import { computerConnectUrl, parseComputerConnectLink } from "@opengeni/sdk/app-links";
import { completeComputerLink, computerLinkAccount } from "../src/main/computer-link";
import type { StoredAccount } from "../src/main/accounts";

const link = parseComputerConnectLink(
  computerConnectUrl({
    webUrl: "https://app.example/workspaces/w1/sessions/s1",
    subjectId: "person",
  }),
)!;
const account = {
  id: "a",
  baseUrl: link.origin,
  subjectId: "person",
  email: "person@example.com",
  workspaceId: "other",
} as StoredAccount;

test("selects the exact account even when another account last used the workspace", () => {
  const wrong = { ...account, id: "wrong", subjectId: "other", workspaceId: "w1" };
  expect(computerLinkAccount(link, [wrong, account])).toBe(account);
  expect(computerLinkAccount(link, [wrong])).toBeNull();
  expect(computerLinkAccount(link, [{ ...account, signedOut: true }])).toBeNull();
});

test("connects only after workspace authorization and human consent, preserving the chat", async () => {
  const events: string[] = [];
  const result = await completeComputerLink({
    link,
    account,
    workspace: async (id) => {
      events.push(`authorize:${id}`);
      return { name: "Design" };
    },
    confirm: async (name) => {
      events.push(`confirm:${name}`);
      return true;
    },
    navigate: (path) => events.push(`navigate:${path}`),
    connect: async (id) => {
      events.push(`connect:${id}`);
    },
  });
  expect(result).toBe(true);
  expect(events).toEqual([
    "authorize:w1",
    "confirm:Design",
    "navigate:/workspaces/w1/sessions/s1",
    "connect:w1",
  ]);
});

test("wrong account, denial and lost workspace access never connect", async () => {
  const connect = mock(async () => {});
  const confirm = mock(async () => false);
  const workspace = mock(async () => ({ name: "Design" }));
  const input = { link, account, connect, confirm, workspace, navigate: () => {} };
  expect(
    await completeComputerLink({ ...input, account: { ...account, subjectId: "other" } }),
  ).toBe(false);
  expect(workspace).not.toHaveBeenCalled();
  expect(await completeComputerLink(input)).toBe(false);
  expect(connect).not.toHaveBeenCalled();
  confirm.mockClear();
  await expect(
    completeComputerLink({
      ...input,
      workspace: async () => {
        throw new Error("Forbidden");
      },
    }),
  ).rejects.toThrow("Forbidden");
  expect(confirm).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
