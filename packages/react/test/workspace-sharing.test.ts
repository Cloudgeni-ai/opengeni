import { expect, test } from "bun:test";
import { soleWorkspacePerson, workspaceHasNobodyToShareWith } from "../src/workspace-sharing";

const member = (subjectId: string) => ({ subjectId });
const viewer = (subjectId: string) => ({ subjectId });

test("a person is alone when no other person shares the workspace", () => {
  expect(soleWorkspacePerson([member("user:me")], viewer("user:me"))).toBe(true);
  // API keys and other principals are not people to share with.
  expect(soleWorkspacePerson([member("user:me"), member("api_key:ci")], viewer("user:me"))).toBe(
    true,
  );
  expect(soleWorkspacePerson([member("user:me"), member("user:anna")], viewer("user:me"))).toBe(
    false,
  );
  // A principal that is not a person never gets a personal-only default.
  expect(soleWorkspacePerson([member("user:me")], viewer("api_key:ci"))).toBe(false);
  expect(soleWorkspacePerson([], viewer("user:me"))).toBe(false);
});

test("the one person on a local install is alone until someone else joins", () => {
  const local = { subjectId: "dev", mode: "local" as const };
  expect(soleWorkspacePerson([member("dev")], local)).toBe(true);
  expect(soleWorkspacePerson([member("dev"), member("user:anna")], local)).toBe(false);
  // A key on a local install is still not a person, nor is the same name elsewhere.
  expect(
    soleWorkspacePerson([member("dev")], {
      ...local,
      credential: { kind: "workspace" } as never,
    }),
  ).toBe(false);
  expect(soleWorkspacePerson([member("dev")], { subjectId: "dev", mode: "managed" })).toBe(false);
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
