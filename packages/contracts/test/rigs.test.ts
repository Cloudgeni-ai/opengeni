import { describe, expect, test } from "bun:test";
import {
  CreateRigRequest,
  ProposeRigChangeRequest,
  Rig,
  RigChange,
  RigChangeKind,
  RigChangeStatus,
  RigCheck,
  RigVersion,
  UpdateRigRequest,
} from "../src/index";

describe("rig contracts", () => {
  test("RigCheck requires a non-empty name and command", () => {
    expect(RigCheck.safeParse({ name: "lint", command: "eslint ." }).success).toBe(true);
    expect(RigCheck.safeParse({ name: "", command: "x" }).success).toBe(false);
    expect(RigCheck.safeParse({ name: "x", command: "" }).success).toBe(false);
  });

  test("CreateRigRequest requires a name and defaults the list fields to []", () => {
    const parsed = CreateRigRequest.parse({ name: "dev" });
    expect(parsed.checks).toEqual([]);
    expect(parsed.credentialHooks).toEqual([]);
    expect(parsed.defaultVariableSetIds).toEqual([]);
    expect(CreateRigRequest.safeParse({ name: "" }).success).toBe(false);
    // A malformed check shape is rejected up front.
    expect(CreateRigRequest.safeParse({ name: "dev", checks: [{ name: "x" }] }).success).toBe(
      false,
    );
    // Non-uuid default variable set ids are rejected.
    expect(
      CreateRigRequest.safeParse({ name: "dev", defaultVariableSetIds: ["not-a-uuid"] }).success,
    ).toBe(false);
  });

  test("UpdateRigRequest accepts a nullable description and partial fields", () => {
    expect(UpdateRigRequest.safeParse({}).success).toBe(true);
    expect(UpdateRigRequest.safeParse({ description: null }).success).toBe(true);
    expect(UpdateRigRequest.safeParse({ name: "" }).success).toBe(false);
  });

  test("ProposeRigChangeRequest is a kind-discriminated union", () => {
    expect(RigChangeKind.options).toEqual(["setup_append", "definition_edit"]);
    expect(
      ProposeRigChangeRequest.safeParse({
        kind: "setup_append",
        payload: { command: "apt-get install -y jq" },
      }).success,
    ).toBe(true);
    // setup_append requires a command.
    expect(ProposeRigChangeRequest.safeParse({ kind: "setup_append", payload: {} }).success).toBe(
      false,
    );
    // definition_edit accepts a partial next-version content.
    expect(
      ProposeRigChangeRequest.safeParse({
        kind: "definition_edit",
        payload: { image: "ubuntu:24.10", changelog: "bump" },
      }).success,
    ).toBe(true);
    // Unknown kind is rejected by the union.
    expect(
      ProposeRigChangeRequest.safeParse({ kind: "delete_everything", payload: {} }).success,
    ).toBe(false);
  });

  test("RigChangeStatus enumerates the full lifecycle", () => {
    expect([...RigChangeStatus.options].sort()).toEqual([
      "failed",
      "merged",
      "proposed",
      "rejected",
      "verifying",
    ]);
  });

  test("Rig / RigVersion / RigChange parse representative rows", () => {
    const version = {
      id: "11111111-1111-4111-8111-111111111111",
      rigId: "22222222-2222-4222-8222-222222222222",
      version: 1,
      image: "ubuntu:24.04",
      setupScript: "apt-get install -y ripgrep",
      checks: [{ name: "rg", command: "rg --version" }],
      credentialHooks: ["azure-cli-login"],
      defaultVariableSetIds: [],
      changelog: "Initial version",
      createdBy: "user:alice",
      active: true,
      createdAt: "2026-07-08T00:00:00.000Z",
    };
    expect(RigVersion.safeParse(version).success).toBe(true);

    const rig = {
      id: "22222222-2222-4222-8222-222222222222",
      accountId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      name: "dev-machine",
      description: null,
      createdBy: "user:alice",
      activeVersion: version,
      activeVersionHealth: null,
      versionCount: 1,
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    };
    expect(Rig.safeParse(rig).success).toBe(true);
    expect(Rig.safeParse({ ...rig, activeVersion: null }).success).toBe(true);
    expect(
      Rig.safeParse({
        ...rig,
        activeVersionHealth: { checkHealth: "passing", lastVerifiedAt: "2026-07-08T00:00:00.000Z" },
      }).success,
    ).toBe(true);

    const change = {
      id: "55555555-5555-4555-8555-555555555555",
      rigId: rig.id,
      baseVersionId: version.id,
      kind: "setup_append",
      payload: { command: "apt-get install -y jq" },
      status: "proposed",
      proposedBy: "session:s1",
      // The verification schema is passthrough — extra M4 keys survive.
      verification: { startedAt: "2026-07-08T00:00:00.000Z", futureField: 1 },
      resultVersionId: null,
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    };
    const parsedChange = RigChange.parse(change);
    expect(parsedChange.verification).toMatchObject({ futureField: 1 });
  });
});
