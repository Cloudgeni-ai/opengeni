import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  assertPrivateSessionArchivePath,
  parseSessionArchiveOperatorArgs,
} from "../scripts/session-archive-operator";

const workspaceId = "00000000-0000-4000-8000-000000000100";
const rootId = "00000000-0000-4000-8000-000000000010";
const sealId = "00000000-0000-4000-8000-000000000030";
const checksum = `sha256:${"a".repeat(64)}`;

describe("session archive operator CLI safety", () => {
  test("parses archive and unarchive plans without accepting a raw credential", () => {
    expect(
      parseSessionArchiveOperatorArgs([
        "plan",
        "--workspace",
        workspaceId,
        "--action",
        "archive",
        "--root",
        rootId,
        "--out",
        "/tmp/ope61-plan.json",
      ]),
    ).toMatchObject({
      command: "plan",
      workspaceId,
      action: "archive",
      roots: [rootId],
      outputPath: "/tmp/ope61-plan.json",
      apiKeyEnv: "OPENGENI_API_KEY",
    });
    expect(
      parseSessionArchiveOperatorArgs([
        "plan",
        "--workspace",
        workspaceId,
        "--action",
        "unarchive",
        "--root",
        `${rootId}=${sealId}`,
        "--out",
        "/tmp/ope61-unarchive.json",
      ]).roots,
    ).toEqual([`${rootId}=${sealId}`]);
    expect(() =>
      parseSessionArchiveOperatorArgs([
        "plan",
        "--workspace",
        workspaceId,
        "--action",
        "archive",
        "--root",
        rootId,
        "--out",
        "/tmp/ope61-plan.json",
        "--api-key",
        "must-not-be-accepted",
      ]),
    ).toThrow("Unknown argument: --api-key");
  });

  test("requires both checksum approval and exact workspace confirmation for apply", () => {
    expect(
      parseSessionArchiveOperatorArgs([
        "apply",
        "--plan",
        "/tmp/ope61-plan.json",
        "--approved-checksum",
        checksum,
        "--confirm-workspace",
        workspaceId,
        "--receipt-out",
        "/tmp/ope61-receipts.json",
      ]),
    ).toMatchObject({
      command: "apply",
      approvedManifestChecksum: checksum,
      confirmedWorkspaceId: workspaceId,
      receiptOutputPath: "/tmp/ope61-receipts.json",
    });
    expect(() =>
      parseSessionArchiveOperatorArgs([
        "apply",
        "--plan",
        "/tmp/ope61-plan.json",
        "--approved-checksum",
        checksum,
        "--receipt-out",
        "/tmp/ope61-receipts.json",
      ]),
    ).toThrow("requires --plan, --approved-checksum, --confirm-workspace, and --receipt-out");
  });

  test("rejects repository-local private evidence paths", () => {
    expect(() => assertPrivateSessionArchivePath(resolve("ope61-private-plan.json"))).toThrow(
      "must stay outside",
    );
    expect(assertPrivateSessionArchivePath("/tmp/ope61-private-plan.json")).toBe(
      "/tmp/ope61-private-plan.json",
    );
  });
});
