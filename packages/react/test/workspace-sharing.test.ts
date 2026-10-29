import { expect, test } from "bun:test";
import { soleWorkspacePerson, workspaceHasNobodyToShareWith } from "../src/workspace-sharing";

const member = (subjectId: string) => ({ subjectId });

test("a person is alone when no other person shares the workspace", () => {
  expect(soleWorkspacePerson([member("user:me")], "user:me")).toBe(true);
  // API keys and other principals are not people to share with.
  expect(soleWorkspacePerson([member("user:me"), member("api_key:ci")], "user:me")).toBe(true);
  expect(soleWorkspacePerson([member("user:me"), member("user:anna")], "user:me")).toBe(false);
  // A principal that is not a person never gets a personal-only default.
  expect(soleWorkspacePerson([member("user:me")], "api_key:ci")).toBe(false);
  expect(soleWorkspacePerson([], "user:me")).toBe(false);
});

test("an unknown membership keeps asking, and one read serves several cards", async () => {
  let reads = 0;
  const alone = {
    listWorkspaceMembers: async () => {
      reads += 1;
      return [{ subjectId: "user:me" }] as never;
    },
    getAccessContext: async () => ({ subjectId: "user:me" }),
  };
  let now = 0;
  const clock = () => now;
  expect(await workspaceHasNobodyToShareWith(alone, "w1", clock)).toBe(true);
  expect(await workspaceHasNobodyToShareWith(alone, "w1", clock)).toBe(true);
  expect(reads).toBe(1);
  now = 61_000;
  expect(await workspaceHasNobodyToShareWith(alone, "w1", clock)).toBe(true);
  expect(reads).toBe(2);
  const failing = {
    listWorkspaceMembers: async () => {
      throw new Error("forbidden");
    },
    getAccessContext: async () => ({ subjectId: "user:me" }),
  };
  expect(await workspaceHasNobodyToShareWith(failing, "w1", clock)).toBe(false);
});
