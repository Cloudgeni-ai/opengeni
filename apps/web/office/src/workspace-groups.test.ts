import { describe, expect, test } from "bun:test";
import type { AccessContext, Workspace } from "@opengeni/sdk";
import { workspaceGroups } from "./workspace-groups";

const workspace = (id: string, accountId: string, name: string): Workspace =>
  ({ id, accountId, name, kind: name.startsWith("Personal") ? "personal" : "shared" }) as Workspace;

const workspaces = [
  workspace("p-acme", "acme", "Personal workspace"),
  workspace("demos", "acme", "Demos"),
  workspace("p-beta", "beta", "Personal workspace"),
  workspace("p-own", "own", "Personal workspace"),
  workspace("default", "own", "Default workspace"),
];

const grant = (accountId: string, accountName: string) => ({
  accountId,
  subjectId: "me",
  role: "member" as const,
  permissions: [],
  metadata: { accountName },
});

const access = {
  mode: "managed",
  subjectId: "me",
  accountGrants: [grant("acme", "Acme"), grant("beta", "Beta Labs"), grant("own", "Bendik")],
  workspaceGrants: [],
  defaultAccountId: "own",
  defaultWorkspaceId: "default",
} as unknown as AccessContext;

describe("the Excel pane's workspace picker", () => {
  test("groups workspaces under their organization, the person's own first", () => {
    expect(
      workspaceGroups(workspaces, access).map((group) => [
        group.label,
        group.workspaces.map((each) => each.id),
      ]),
    ).toEqual([
      ["Bendik", ["default", "p-own"]],
      ["Acme", ["demos", "p-acme"]],
      ["Beta Labs", ["p-beta"]],
    ]);
  });

  test("still separates organizations without the access context", () => {
    const groups = workspaceGroups(workspaces, null);
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((group) => group.label)).size).toBe(3);
  });
});
