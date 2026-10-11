// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  consumeToolGatewayApproval,
  beginTargetToolGatewayCall,
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
  test("target bindings preserve one operation namespace and consumed tombstones across policy and protocol changes", async () => {
    if (!shared || !client) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "target-approval-test",
      accountExternalId: suffix,
      accountName: "Target test",
      workspaceExternalSource: "target-approval-test",
      workspaceExternalId: suffix,
      workspaceName: "Target test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const base = {
      ...grant,
      operationId: crypto.randomUUID(),
      identity: { serverId: "account-exact", toolName: "write" },
      argumentsDigest: "a".repeat(64),
      approvalAuthorityDigest: "b".repeat(64),
    };
    const target = { ...base, targetBindingDigest: "c".repeat(64), tokenHash: "d".repeat(64) };
    try {
      await issueToolGatewayApproval(client.db, {
        ...target,
        bindingVersion: 2,
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(
        await consumeToolGatewayApproval(client.db, {
          ...target,
          catalogDigest: target.targetBindingDigest,
        }),
      ).toBe(false);
      expect(
        await beginTargetToolGatewayCall(client.db, {
          ...target,
          targetBindingDigest: "f".repeat(64),
          approvalRequired: true,
        }),
      ).toBe(false);
      const starts = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          beginTargetToolGatewayCall(client!.db, { ...target, approvalRequired: true }),
        ),
      );
      expect(starts.filter((entry) => entry.status === "fulfilled" && entry.value)).toHaveLength(1);
      expect(starts.filter((entry) => entry.status === "rejected")).toHaveLength(3);
      // The current policy now allows. Neither an old token nor omission repairs a consumed operation.
      for (const tokenHash of [target.tokenHash, undefined]) {
        await expect(
          beginTargetToolGatewayCall(client.db, {
            ...base,
            targetBindingDigest: target.targetBindingDigest,
            ...(tokenHash ? { tokenHash } : {}),
            approvalRequired: false,
          }),
        ).rejects.toBeInstanceOf(ToolGatewayApprovalOperationStartedError);
      }
      await expect(
        issueToolGatewayApproval(client.db, {
          ...base,
          tokenHash: "e".repeat(64),
          catalogDigest: target.targetBindingDigest,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toBeInstanceOf(ToolGatewayApprovalOperationStartedError);
      await expect(
        issueToolGatewayApproval(client.db, {
          ...target,
          tokenHash: "f".repeat(64),
          bindingVersion: 2,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toBeInstanceOf(ToolGatewayApprovalOperationStartedError);
      const [row] =
        await shared.admin`select binding_version, catalog_digest, target_binding_digest, consumed_at from tool_gateway_approval_capabilities where workspace_id = ${grant.workspaceId} and operation_id = ${base.operationId}`;
      expect(row).toMatchObject({
        binding_version: 2,
        catalog_digest: null,
        target_binding_digest: target.targetBindingDigest,
      });
      expect(row!.consumed_at).toBeInstanceOf(Date);
    } finally {
      await deleteWorkspace(client.db, grant.workspaceId);
    }
  }, 180_000);

  test("Ask to Allow settles matching pending provenance; forged tokens and v1 tombstones cannot be ignored", async () => {
    if (!shared || !client) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "target-approval-test",
      accountExternalId: suffix,
      accountName: "Target test",
      workspaceExternalSource: "target-approval-test",
      workspaceExternalId: suffix,
      workspaceName: "Target test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const base = {
      ...grant,
      operationId: crypto.randomUUID(),
      identity: { serverId: "exact", toolName: "write" },
      argumentsDigest: "1".repeat(64),
      approvalAuthorityDigest: "2".repeat(64),
    };
    try {
      const digest = "3".repeat(64);
      await issueToolGatewayApproval(client.db, {
        ...base,
        bindingVersion: 2,
        targetBindingDigest: digest,
        tokenHash: "4".repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(
        await beginTargetToolGatewayCall(client.db, {
          ...base,
          targetBindingDigest: digest,
          tokenHash: "5".repeat(64),
          approvalRequired: false,
        }),
      ).toBe(false);
      expect(
        await beginTargetToolGatewayCall(client.db, {
          ...base,
          targetBindingDigest: digest,
          approvalRequired: false,
        }),
      ).toBe(true);
      const old = {
        ...base,
        operationId: crypto.randomUUID(),
        catalogDigest: digest,
        tokenHash: "6".repeat(64),
      };
      await issueToolGatewayApproval(client.db, {
        ...old,
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(
        await beginTargetToolGatewayCall(client.db, {
          ...old,
          targetBindingDigest: digest,
          approvalRequired: false,
        }),
      ).toBe(false);
      expect(await consumeToolGatewayApproval(client.db, old)).toBe(true);
      await expect(
        beginTargetToolGatewayCall(client.db, {
          ...old,
          targetBindingDigest: digest,
          approvalRequired: false,
        }),
      ).rejects.toBeInstanceOf(ToolGatewayApprovalOperationStartedError);
      await expect(
        Promise.resolve(
          shared.admin`update tool_gateway_approval_capabilities set catalog_digest = ${digest} where operation_id = ${base.operationId}`,
        ),
      ).rejects.toThrow();
    } finally {
      await deleteWorkspace(client.db, grant.workspaceId);
    }
  }, 180_000);

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
