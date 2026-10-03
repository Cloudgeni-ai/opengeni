import { expect, mock, test } from "bun:test";
import type { WorkspaceInstructionPolicyListResponse } from "@opengeni/sdk";

mock.module("@/context", () => ({ useAppContext: () => ({}) }));
const { instructionRevisions } = await import("./knowledge-instructions");

const target = { kind: "policy", scope: "global", roleKey: null } as const;
function revision(id: string, content: string, source = "human") {
  return {
    id,
    revision: 1,
    contentHash: "a".repeat(64),
    operationId: id,
    accountId: "account",
    workspaceId: "workspace",
    ...target,
    content,
    provenance: { source, sourceId: null },
    supersedesRevisionId: null,
    createdBySubjectId: "user:maja",
    createdAt: "2026-09-20T10:00:00.000Z",
  };
}
function event(id: string, revisionId: string, version: number, type: string, actor: string) {
  return {
    id,
    operationId: id,
    accountId: "account",
    workspaceId: "workspace",
    ...target,
    type,
    activationVersion: version,
    oldRevision: null,
    newRevision: { id: revisionId, revision: version, contentHash: "a".repeat(64) },
    actorSubjectId: actor,
    reason: "x",
    createdAt: `2026-09-2${version}T10:00:00.000Z`,
  };
}

test("history lists every activated version, newest first, in plain words", () => {
  const response = {
    revisions: [
      revision("r1", "Keep updates short."),
      revision("r2", "Keep updates short.\nLink the Linear issue.", "agent_learning"),
    ],
    activeHeads: [],
    inactiveHeads: [],
    inactiveHeadsTruncated: false,
    activationEvents: [
      event("e1", "r1", 1, "activate", "user:me"),
      event("e2", "r2", 2, "activate", "service:learning"),
      event("e3", "r1", 3, "rollback", "user:maja"),
      // Another target never shows up in the workspace instructions history.
      { ...event("e4", "r2", 4, "activate", "user:me"), scope: "role", roleKey: "reviewer" },
    ],
    deactivationEvents: [],
    nextAfterRevision: null,
  } as unknown as WorkspaceInstructionPolicyListResponse;
  const history = instructionRevisions(response, "user:me");
  expect(history.map((each) => [each.summary, each.author, each.revisionId])).toEqual([
    ["Restored an earlier version", "A workspace admin", "r1"],
    ["Approved an agent's change", "Opengeni", "r2"],
    ["Created the instructions", "You", "r1"],
  ]);
  expect(history[1]?.content).toContain("Link the Linear issue.");
});
