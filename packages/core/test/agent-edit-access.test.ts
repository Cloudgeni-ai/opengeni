import { describe, expect, test } from "bun:test";
import {
  agentEditableBy,
  agentManageableBy,
  agentViewerCanMakePrivate,
  type AgentViewer,
} from "../src/domain/agents";

// Who can edit a shared agent: its creator and admins always may; with "Who
// can edit" set to everyone, so may anyone in its workspace who can start
// chats. Who can use or edit it, and deleting it, stay with creator and admins.

const creator: AgentViewer = { subjectId: "user:alice", admin: false, contributor: true };
const member: AgentViewer = { subjectId: "user:bob", admin: false, contributor: true };
const reader: AgentViewer = { subjectId: "user:carol", admin: false, contributor: false };
const admin: AgentViewer = { subjectId: "user:admin", admin: true, contributor: true };

function agent(
  editAccess: "creator_and_admins" | "everyone",
  visibility: "workspace" | "private" = "workspace",
) {
  return {
    visibility,
    ownerSubjectId: visibility === "private" ? "user:alice" : null,
    createdBySubjectId: "user:alice",
    editAccess,
  };
}

describe("agent edit access", () => {
  test("creator and admins: only they edit", () => {
    const restricted = agent("creator_and_admins");
    expect(agentEditableBy(creator, restricted)).toBe(true);
    expect(agentEditableBy(admin, restricted)).toBe(true);
    expect(agentEditableBy(member, restricted)).toBe(false);
    expect(agentEditableBy(reader, restricted)).toBe(false);
  });

  test("everyone: any member who can start chats edits, but doesn't manage", () => {
    const open = agent("everyone");
    expect(agentEditableBy(member, open)).toBe(true);
    expect(agentEditableBy(reader, open)).toBe(false);
    expect(agentManageableBy(member, open)).toBe(false);
    expect(agentManageableBy(creator, open)).toBe(true);
    expect(agentManageableBy(admin, open)).toBe(true);
    expect(agentViewerCanMakePrivate(member, open)).toBe(false);
  });

  test("an Only me agent stays its owner's whatever the setting says", () => {
    const mine = agent("everyone", "private");
    expect(agentEditableBy(member, mine)).toBe(false);
    expect(agentEditableBy(creator, mine)).toBe(true);
  });

  test("a missing setting reads as creator and admins", () => {
    const { editAccess: _ignored, ...legacy } = agent("everyone");
    expect(agentEditableBy(member, legacy)).toBe(false);
  });
});
