// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  consumeToolGatewayApproval,
  createDb,
  deleteWorkspace,
  issueToolGatewayApproval,
  ToolGatewayApprovalOperationStartedError,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("tool-gateway-approvals");
  if (!shared && requireRealDatabase) {
    throw new Error("tool gateway approvals require real PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("tool gateway approval capabilities", () => {
  test("binds one hash-only capability to the exact current human call and consumes it once", async () => {
    if (!shared || !client) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "tool-gateway-approval-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Tool gateway approval test",
      workspaceExternalSource: "tool-gateway-approval-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Tool gateway approval test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const tokenHash = "a".repeat(64);
    const operationId = crypto.randomUUID();
    const identity = { serverId: "docs", toolName: "t".repeat(512) };
    const common = {
      tokenHash,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      operationId,
      catalogDigest: "b".repeat(64),
      identity,
      argumentsDigest: "c".repeat(64),
      approvalAuthorityDigest: "d".repeat(64),
    };
    try {
      await issueToolGatewayApproval(client.db, {
        ...common,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      });
      await issueToolGatewayApproval(client.db, {
        ...common,
        tokenHash: "e".repeat(64),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      });
      const [stored] = await shared.admin<
        Array<{ token_hash: string; authority_digest: string; consumed_at: Date | null }>
      >`
        select token_hash, authority_digest, consumed_at
        from tool_gateway_approval_capabilities
        where workspace_id = ${grant.workspaceId}
          and subject_id = ${grant.subjectId}
          and operation_id = ${operationId}`;
      expect(stored).toEqual({
        token_hash: "e".repeat(64),
        authority_digest: "d".repeat(64),
        consumed_at: null,
      });
      expect(
        await consumeToolGatewayApproval(client.db, {
          ...common,
          tokenHash: "e".repeat(64),
          approvalAuthorityDigest: "f".repeat(64),
        }),
      ).toBe(false);
      expect(
        await consumeToolGatewayApproval(client.db, { ...common, tokenHash: "e".repeat(64) }),
      ).toBe(true);
      expect(
        await consumeToolGatewayApproval(client.db, { ...common, tokenHash: "e".repeat(64) }),
      ).toBe(false);
      await expect(
        issueToolGatewayApproval(client.db, {
          ...common,
          tokenHash: "f".repeat(64),
          expiresAt: new Date(Date.now() + 5 * 60_000),
        }),
      ).rejects.toBeInstanceOf(ToolGatewayApprovalOperationStartedError);
      const [tombstone] = await shared.admin<
        Array<{ token_hash: string; consumed_at: Date | null }>
      >`
        select token_hash, consumed_at
        from tool_gateway_approval_capabilities
        where workspace_id = ${grant.workspaceId}
          and subject_id = ${grant.subjectId}
          and operation_id = ${operationId}`;
      expect(tombstone?.token_hash).toBe("e".repeat(64));
      expect(tombstone?.consumed_at).toBeInstanceOf(Date);
    } finally {
      await deleteWorkspace(client.db, grant.workspaceId);
    }
  });
});
