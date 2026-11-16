import { expect, test } from "bun:test";
import type { ConnectionMetadata } from "../types";
import { findConnectRecoveryTarget } from "./connect-recovery-account";

type Account = { id: string; providerId: string };
const find = (accounts: readonly Account[], id: string) =>
  accounts.find((account) => account.id === id) ?? null;
const own = (id: string, workspaceId: string) =>
  ({ id, workspaceId, subjectId: "me" }) as ConnectionMetadata;

function lookup(input: {
  byWorkspace: Record<string, Account[]>;
  ownAccounts?: ConnectionMetadata[] | Error;
  connectionId: string;
}) {
  const reads: string[] = [];
  return {
    reads,
    target: findConnectRecoveryTarget<Account>({
      workspaceId: "here",
      connectionId: input.connectionId,
      accounts: async (workspaceId) => {
        reads.push(workspaceId);
        return input.byWorkspace[workspaceId] ?? [];
      },
      ownAccounts: async () => {
        if (input.ownAccounts instanceof Error) throw input.ownAccounts;
        return input.ownAccounts ?? [];
      },
      find,
    }),
  };
}

test("an account of this workspace is recovered here", async () => {
  const { target, reads } = lookup({
    byWorkspace: { here: [{ id: "direct", providerId: "gmail" }] },
    connectionId: "direct",
  });
  expect(await target).toEqual({
    account: { id: "direct", providerId: "gmail" },
    workspaceId: "here",
  });
  expect(reads).toEqual(["here"]);
});

test("an own account turned on here from another workspace is recovered in that workspace", async () => {
  const { target, reads } = lookup({
    byWorkspace: {
      here: [],
      "integration-tests": [{ id: "use-it-here", providerId: "gmail" }],
    },
    ownAccounts: [own("use-it-here", "integration-tests")],
    connectionId: "use-it-here",
  });
  expect(await target).toEqual({
    account: { id: "use-it-here", providerId: "gmail" },
    workspaceId: "integration-tests",
  });
  expect(reads).toEqual(["here", "integration-tests"]);
});

test("an account in neither list, or an unreadable inventory, is not found", async () => {
  expect(
    await lookup({ byWorkspace: { here: [] }, ownAccounts: [], connectionId: "gone" }).target,
  ).toBeNull();
  expect(
    await lookup({ byWorkspace: { here: [] }, ownAccounts: new Error("403"), connectionId: "gone" })
      .target,
  ).toBeNull();
  // Shared accounts are never looked up elsewhere.
  expect(
    await lookup({
      byWorkspace: { here: [], other: [{ id: "shared", providerId: "gmail" }] },
      ownAccounts: [{ ...own("shared", "other"), subjectId: null }],
      connectionId: "shared",
    }).target,
  ).toBeNull();
});
