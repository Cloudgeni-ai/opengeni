import { expect, test } from "bun:test";
import { ownAccountHomeWorkspaces } from "../src/workspace-tool-gateway";

const caller = { subjectId: "user:me", workspaceId: "workspace-b" };

test("only the caller's own accounts from another workspace redirect a credential read", () => {
  const homes = ownAccountHomeWorkspaces(
    [
      {
        connectionId: "mine",
        subjectScope: "subject",
        ownerSubjectId: "user:me",
        originWorkspaceId: "workspace-a",
      },
      {
        connectionId: "colleague",
        subjectScope: "subject",
        ownerSubjectId: "user:colleague",
        originWorkspaceId: "workspace-a",
      },
      {
        connectionId: "unowned",
        subjectScope: "subject",
        ownerSubjectId: null,
        originWorkspaceId: "workspace-a",
      },
      {
        connectionId: "shared",
        subjectScope: "workspace",
        ownerSubjectId: "user:me",
        originWorkspaceId: "workspace-a",
      },
      {
        connectionId: "local",
        subjectScope: "subject",
        ownerSubjectId: "user:me",
        originWorkspaceId: "workspace-b",
      },
    ],
    caller,
  );
  expect([...homes]).toEqual([["mine", "workspace-a"]]);
});
