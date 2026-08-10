import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  type SlackUserLinkAccessRequest,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import {
  approveSlackUserLinkAccessRequest,
  cancelSlackUserLinkAccessRequest,
  completeSlackUserLinkAccessIfGranted,
  createConnection,
  createDb,
  getSlackBotUserLink,
  getSlackUserLinkAccessRequestForSubject,
  grantWorkspaceAccess,
  prepareSlackUserLinkAccessRequest,
  requestSlackUserLinkWorkspaceAccess,
  SlackUserLinkAccessPersistenceError,
  type Database,
  type DbClient,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let runtime: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("slack-user-link-access");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[slack-user-link-access] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    return;
  }
  admin = shared.admin;
  runtime = postgres(shared.appUrl, { max: 1 });
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await runtime?.end();
  await shared?.release();
}, 180_000);

async function workspace(label: string) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`Slack access ${label}`}) returning id`;
  const [created] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`Slack access ${label}`}) returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${created!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: created!.id };
}

async function slackConnection(target: { accountId: string; workspaceId: string }, label: string) {
  return await createConnection(db, {
    ...target,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    credentialEncrypted: `fixture-${label}`,
    grantedScopes: ["app_mentions:read", "chat:write", "commands", "im:history"],
    verifiedInstallAt: new Date(),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: `T_${label}`,
      slackTeamName: `Slack ${label}`,
      botId: `B_${label}`,
      botUserId: `UB_${label}`,
      botDisplayName: "OpenGeni",
      verifiedAt: new Date().toISOString(),
    },
  });
}

function digest(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

async function preparedFixture(label: string, subjectId = `user:${randomUUID()}`) {
  const target = await workspace(label);
  const connection = await slackConnection(target, label);
  const token = `signed-slack-link-${label}-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  const prepared = await prepareSlackUserLinkAccessRequest(db, {
    ...target,
    tokenDigest: digest(token),
    connectionId: connection.id,
    slackTeamId: `T_${label}`,
    slackUserId: `U_${label}`,
    subjectId,
    subjectLabel: `${label}@example.test`,
    expiresAt,
  });
  return { target, connection, token, expiresAt, subjectId, prepared };
}

function pendingResult(
  prepared: SlackUserLinkAccessRequest,
  workspaceId = prepared.workspaceId,
): SlackUserLinkAccessRequest {
  const now = new Date().toISOString();
  return {
    ...prepared,
    workspaceId,
    status: "pending",
    version: 2,
    requestedAt: now,
    updatedAt: now,
  };
}

async function insertOperationReceipt(input: {
  accountId: string;
  workspaceId: string;
  requestId: string;
  result: postgres.JSONValue;
}) {
  return await admin`
    insert into slack_user_link_access_request_operations (
      account_id, workspace_id, request_id, actor_subject_id, operation,
      idempotency_key, request_digest, expected_version, result_version,
      result_status, result
    ) values (
      ${input.accountId}, ${input.workspaceId}, ${input.requestId},
      ${`user:${randomUUID()}`}, 'request', ${randomUUID()}, ${"a".repeat(64)},
      1, 2, 'pending', ${admin.json(input.result)}
    )`;
}

describe("Slack user-link access migration and lifecycle", () => {
  test("declares rolling FORCE-RLS tables, exact constraints, policies, and runtime DML", async () => {
    const candidates = (await readdir(migrationsDir)).filter((file) =>
      file.endsWith("_slack_user_link_access_requests.sql"),
    );
    expect(candidates).toHaveLength(1);
    const sql = await readFile(join(migrationsDir, candidates[0]!), "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(
      sql.match(/opengeni_private\.workspace_rls_visible\("account_id", "workspace_id"\)/g),
    ).toHaveLength(2);
    expect(sql).toContain("slack_user_link_access_requests_active_principal_uq");
    expect(sql).toContain("slack_user_link_access_request_operations_idempotency_uq");
    expect(sql).toContain("slack_user_link_access_requests_tenant_uq");
    expect(sql).toContain("slack_user_link_access_request_operations_request_tenant_fk");
    expect(sql).toContain('"result" jsonb NOT NULL');
    expect(sql).toContain('"result" - ARRAY[');
    expect(sql).toContain("] = '{}'::jsonb");
    expect(sql).toContain("slack_user_link_access_requests_lifecycle_check");
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "slack_user_link_access_requests" TO "opengeni_app"',
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT ON TABLE "slack_user_link_access_request_operations" TO "opengeni_app"',
    );

    if (!available) return;
    const rows = await admin<
      {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        canSelect: boolean;
        canInsert: boolean;
        canUpdate: boolean;
        canDelete: boolean;
        canTruncate: boolean;
      }[]
    >`
      select
        C.relname,
        C.relrowsecurity,
        C.relforcerowsecurity,
        has_table_privilege('opengeni_app', C.oid, 'select') as "canSelect",
        has_table_privilege('opengeni_app', C.oid, 'insert') as "canInsert",
        has_table_privilege('opengeni_app', C.oid, 'update') as "canUpdate",
        has_table_privilege('opengeni_app', C.oid, 'delete') as "canDelete",
        has_table_privilege('opengeni_app', C.oid, 'truncate') as "canTruncate"
      from pg_class C
      where C.oid in (
        'slack_user_link_access_requests'::regclass,
        'slack_user_link_access_request_operations'::regclass
      )
      order by C.relname`;
    expect(rows).toHaveLength(2);
    expect([...rows]).toEqual([
      {
        relname: "slack_user_link_access_request_operations",
        relrowsecurity: true,
        relforcerowsecurity: true,
        canSelect: true,
        canInsert: true,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
      },
      {
        relname: "slack_user_link_access_requests",
        relrowsecurity: true,
        relforcerowsecurity: true,
        canSelect: true,
        canInsert: true,
        canUpdate: true,
        canDelete: false,
        canTruncate: false,
      },
    ]);
    await expect(
      Promise.resolve(runtime`delete from slack_user_link_access_requests where false`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      Promise.resolve(
        runtime`update slack_user_link_access_request_operations set result_status = result_status where false`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      Promise.resolve(runtime`delete from slack_user_link_access_request_operations where false`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("binds operation receipts to one tenant and an exact token-free result shape", async () => {
    if (!available) return;

    const tenantFixture = await preparedFixture("receipt-tenant");
    const otherTenant = await workspace("receipt-other-tenant");
    await expect(
      insertOperationReceipt({
        ...otherTenant,
        requestId: tenantFixture.prepared.id,
        result: pendingResult(tenantFixture.prepared, otherTenant.workspaceId),
      }),
    ).rejects.toMatchObject({ code: "23503" });

    const shapeFixture = await preparedFixture("receipt-shape");
    const exact = pendingResult(shapeFixture.prepared);
    await expect(
      insertOperationReceipt({
        ...shapeFixture.target,
        requestId: shapeFixture.prepared.id,
        result: { ...exact, linkToken: "must-not-persist" },
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertOperationReceipt({
        ...shapeFixture.target,
        requestId: shapeFixture.prepared.id,
        result: { ...exact, rawToken: "must-not-persist" },
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertOperationReceipt({
        ...shapeFixture.target,
        requestId: shapeFixture.prepared.id,
        result: { ...exact, subjectLabel: { bearer: "must-not-persist" } },
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertOperationReceipt({
        ...shapeFixture.target,
        requestId: shapeFixture.prepared.id,
        result: { ...exact, version: "2" },
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertOperationReceipt({
        ...shapeFixture.target,
        requestId: shapeFixture.prepared.id,
        result: { ...exact, version: 2.5 },
      }),
    ).rejects.toMatchObject({ code: "23514" });

    await insertOperationReceipt({
      ...shapeFixture.target,
      requestId: shapeFixture.prepared.id,
      result: exact,
    });
    const [stored] = await admin<{ result: SlackUserLinkAccessRequest }[]>`
      select result from slack_user_link_access_request_operations
      where request_id = ${shapeFixture.prepared.id}`;
    expect(stored?.result).toEqual(exact);
    expect(Object.keys(stored!.result).sort()).toEqual(
      [
        "completedAt",
        "createdAt",
        "decidedAt",
        "expiresAt",
        "id",
        "requestedAt",
        "status",
        "subjectLabel",
        "updatedAt",
        "version",
        "workspaceDisplayName",
        "workspaceId",
      ].sort(),
    );
  });

  test("stores only the digest, binds exact claims and subject, and supersedes only a fresh exact-subject intent", async () => {
    if (!available) return;
    const fixture = await preparedFixture("prepare");
    expect(fixture.prepared).not.toHaveProperty("token");
    expect(fixture.prepared).not.toHaveProperty("tokenDigest");

    const [stored] = await admin<
      { id: string; tokenDigest: string; subjectId: string; status: string }[]
    >`
      select id, token_digest as "tokenDigest", subject_id as "subjectId", status
      from slack_user_link_access_requests where id = ${fixture.prepared.id}`;
    expect(stored).toMatchObject({
      tokenDigest: digest(fixture.token),
      subjectId: fixture.subjectId,
      status: "prepared",
    });
    expect(JSON.stringify(stored)).not.toContain(fixture.token);

    const replay = await prepareSlackUserLinkAccessRequest(db, {
      ...fixture.target,
      tokenDigest: digest(fixture.token),
      connectionId: fixture.connection.id,
      slackTeamId: "T_prepare",
      slackUserId: "U_prepare",
      subjectId: fixture.subjectId,
      subjectLabel: "prepare@example.test",
      expiresAt: fixture.expiresAt,
    });
    expect(replay.id).toBe(fixture.prepared.id);

    await expect(
      prepareSlackUserLinkAccessRequest(db, {
        ...fixture.target,
        tokenDigest: digest(fixture.token),
        connectionId: fixture.connection.id,
        slackTeamId: "T_prepare",
        slackUserId: "U_prepare",
        subjectId: `user:${randomUUID()}`,
        expiresAt: fixture.expiresAt,
      }),
    ).rejects.toMatchObject({ code: "subject_mismatch" });

    const replacementToken = `replacement-${randomUUID()}`;
    const replacement = await prepareSlackUserLinkAccessRequest(db, {
      ...fixture.target,
      tokenDigest: digest(replacementToken),
      connectionId: fixture.connection.id,
      slackTeamId: "T_prepare",
      slackUserId: "U_prepare",
      subjectId: fixture.subjectId,
      subjectLabel: "prepare@example.test",
      expiresAt: new Date(fixture.expiresAt.getTime() + 1_000),
    });
    expect(replacement.id).not.toBe(fixture.prepared.id);
    const [old] = await admin<{ status: string }[]>`
      select status from slack_user_link_access_requests where id = ${fixture.prepared.id}`;
    expect(old?.status).toBe("cancelled");
  });

  test("uses CAS plus durable idempotency and atomically grants membership before linking", async () => {
    if (!available) return;
    const fixture = await preparedFixture("approve");
    const requestKey = randomUUID();
    const [pending, replay] = await Promise.all([
      requestSlackUserLinkWorkspaceAccess(db, {
        workspaceId: fixture.target.workspaceId,
        requestId: fixture.prepared.id,
        actorSubjectId: fixture.subjectId,
        expectedVersion: fixture.prepared.version,
        idempotencyKey: requestKey,
      }),
      requestSlackUserLinkWorkspaceAccess(db, {
        workspaceId: fixture.target.workspaceId,
        requestId: fixture.prepared.id,
        actorSubjectId: fixture.subjectId,
        expectedVersion: fixture.prepared.version,
        idempotencyKey: requestKey,
      }),
    ]);
    expect(pending).toMatchObject({ status: "pending", version: 2 });
    expect(replay).toMatchObject({ id: pending.id, status: "pending", version: 2 });

    await expect(
      requestSlackUserLinkWorkspaceAccess(db, {
        workspaceId: fixture.target.workspaceId,
        requestId: fixture.prepared.id,
        actorSubjectId: fixture.subjectId,
        expectedVersion: pending.version,
        idempotencyKey: requestKey,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const approved = await approveSlackUserLinkAccessRequest(db, {
      workspaceId: fixture.target.workspaceId,
      requestId: pending.id,
      actorSubjectId: `user:admin-${randomUUID()}`,
      expectedVersion: pending.version,
      idempotencyKey: randomUUID(),
      role: "member",
      permissions: ["sessions:create", "sessions:read"],
    });
    expect(approved).toMatchObject({ status: "completed", version: 3 });
    const [membership] = await admin<{ role: string; permissions: string[]; createdAt: Date }[]>`
      select role, permissions, created_at as "createdAt"
      from workspace_memberships
      where workspace_id = ${fixture.target.workspaceId} and subject_id = ${fixture.subjectId}`;
    const link = await getSlackBotUserLink(
      db,
      fixture.target.workspaceId,
      fixture.connection.id,
      "U_approve",
    );
    expect(membership).toMatchObject({
      role: "member",
      permissions: ["sessions:create", "sessions:read"],
    });
    expect(link?.subjectId).toBe(fixture.subjectId);

    const audits = await admin<
      {
        action: string;
        metadata: {
          membershipPermissions?: string[];
          membershipRole?: string;
          status: string;
          version: number;
        };
      }[]
    >`
      select action, metadata from audit_events
      where target_type = 'slack_user_link_access_request'
        and target_id = ${fixture.prepared.id}`;
    expect(audits).toHaveLength(4);
    const auditCounts = audits.reduce<Record<string, number>>((counts, row) => {
      counts[row.action] = (counts[row.action] ?? 0) + 1;
      return counts;
    }, {});
    expect(auditCounts).toEqual({
      "slack.user_link.prepared": 1,
      "workspace.access_request.created": 1,
      "workspace.access_request.approved": 1,
      "slack.user_link.completed": 1,
    });
    const auditsByAction = Object.fromEntries(audits.map((row) => [row.action, row.metadata]));
    expect(Object.keys(auditsByAction).sort()).toEqual([
      "slack.user_link.completed",
      "slack.user_link.prepared",
      "workspace.access_request.approved",
      "workspace.access_request.created",
    ]);
    expect(auditsByAction["slack.user_link.prepared"]).toMatchObject({
      status: "prepared",
      version: 1,
    });
    expect(auditsByAction["workspace.access_request.created"]).toMatchObject({
      status: "pending",
      version: 2,
    });
    expect(auditsByAction["workspace.access_request.approved"]).toMatchObject({
      status: "completed",
      version: 3,
      membershipRole: "member",
      membershipPermissions: ["sessions:create", "sessions:read"],
    });
    expect(auditsByAction["slack.user_link.completed"]).toMatchObject({
      status: "completed",
      version: 3,
    });
    expect(JSON.stringify(audits)).not.toContain(fixture.token);
    expect(JSON.stringify(audits)).not.toContain(digest(fixture.token));
  });

  test("replays the stored original result before expiry or later approval without side effects", async () => {
    if (!available) return;

    const expiring = await preparedFixture("replay-expiry");
    const expiringKey = randomUUID();
    const originalPending = await requestSlackUserLinkWorkspaceAccess(db, {
      workspaceId: expiring.target.workspaceId,
      requestId: expiring.prepared.id,
      actorSubjectId: expiring.subjectId,
      expectedVersion: expiring.prepared.version,
      idempotencyKey: expiringKey,
    });
    const [expiryAuditCountBefore] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where target_type = 'slack_user_link_access_request'
        and target_id = ${expiring.prepared.id}`;
    const [expiryReceiptBefore] = await admin<
      { count: number; result: SlackUserLinkAccessRequest }[]
    >`
      select count(*)::int as count, min(result::text)::jsonb as result
      from slack_user_link_access_request_operations
      where request_id = ${expiring.prepared.id}`;
    expect(expiryReceiptBefore).toMatchObject({ count: 1, result: originalPending });
    expect(Object.keys(expiryReceiptBefore!.result).sort()).toEqual(
      Object.keys(originalPending).sort(),
    );
    expect(
      await requestSlackUserLinkWorkspaceAccess(
        db,
        {
          workspaceId: expiring.target.workspaceId,
          requestId: expiring.prepared.id,
          actorSubjectId: expiring.subjectId,
          expectedVersion: expiring.prepared.version,
          idempotencyKey: expiringKey,
        },
        new Date(expiring.expiresAt.getTime() + 1),
      ),
    ).toEqual(originalPending);
    const [afterExpiryReplay] = await admin<{ status: string; version: number }[]>`
      select status, version from slack_user_link_access_requests
      where id = ${expiring.prepared.id}`;
    const [expiryAuditCountAfter] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where target_type = 'slack_user_link_access_request'
        and target_id = ${expiring.prepared.id}`;
    const [expiryReceiptAfter] = await admin<{ count: number }[]>`
      select count(*)::int as count from slack_user_link_access_request_operations
      where request_id = ${expiring.prepared.id}`;
    expect(afterExpiryReplay).toEqual({ status: "pending", version: 2 });
    expect(expiryAuditCountAfter).toEqual(expiryAuditCountBefore);
    expect(expiryReceiptAfter).toEqual({ count: expiryReceiptBefore!.count });

    const approvedFixture = await preparedFixture("replay-approval");
    const approvedKey = randomUUID();
    const pendingBeforeApproval = await requestSlackUserLinkWorkspaceAccess(db, {
      workspaceId: approvedFixture.target.workspaceId,
      requestId: approvedFixture.prepared.id,
      actorSubjectId: approvedFixture.subjectId,
      expectedVersion: approvedFixture.prepared.version,
      idempotencyKey: approvedKey,
    });
    const approved = await approveSlackUserLinkAccessRequest(db, {
      workspaceId: approvedFixture.target.workspaceId,
      requestId: approvedFixture.prepared.id,
      actorSubjectId: `user:admin-${randomUUID()}`,
      expectedVersion: pendingBeforeApproval.version,
      idempotencyKey: randomUUID(),
      permissions: ["sessions:create"],
    });
    const [approvalAuditCountBefore] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where target_type = 'slack_user_link_access_request'
        and target_id = ${approvedFixture.prepared.id}`;
    const [membershipCountBefore] = await admin<{ count: number }[]>`
      select count(*)::int as count from workspace_memberships
      where workspace_id = ${approvedFixture.target.workspaceId}
        and subject_id = ${approvedFixture.subjectId}`;
    const [linkCountBefore] = await admin<{ count: number }[]>`
      select count(*)::int as count from slack_bot_user_links
      where workspace_id = ${approvedFixture.target.workspaceId}
        and connection_id = ${approvedFixture.connection.id}
        and slack_user_id = 'U_replay-approval'`;
    const [approvalReceiptBefore] = await admin<
      { count: number; result: SlackUserLinkAccessRequest }[]
    >`
      select count(*)::int as count,
        (min(result::text) filter (where operation = 'request'))::jsonb as result
      from slack_user_link_access_request_operations
      where request_id = ${approvedFixture.prepared.id}`;
    expect(approvalReceiptBefore).toMatchObject({ count: 2, result: pendingBeforeApproval });
    expect(
      await requestSlackUserLinkWorkspaceAccess(db, {
        workspaceId: approvedFixture.target.workspaceId,
        requestId: approvedFixture.prepared.id,
        actorSubjectId: approvedFixture.subjectId,
        expectedVersion: approvedFixture.prepared.version,
        idempotencyKey: approvedKey,
      }),
    ).toEqual(pendingBeforeApproval);
    const [afterApprovalReplay] = await admin<{ status: string; version: number }[]>`
      select status, version from slack_user_link_access_requests
      where id = ${approvedFixture.prepared.id}`;
    const [approvalAuditCountAfter] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where target_type = 'slack_user_link_access_request'
        and target_id = ${approvedFixture.prepared.id}`;
    const [membershipCountAfter] = await admin<{ count: number }[]>`
      select count(*)::int as count from workspace_memberships
      where workspace_id = ${approvedFixture.target.workspaceId}
        and subject_id = ${approvedFixture.subjectId}`;
    const [linkCountAfter] = await admin<{ count: number }[]>`
      select count(*)::int as count from slack_bot_user_links
      where workspace_id = ${approvedFixture.target.workspaceId}
        and connection_id = ${approvedFixture.connection.id}
        and slack_user_id = 'U_replay-approval'`;
    const [approvalReceiptAfter] = await admin<{ count: number }[]>`
      select count(*)::int as count from slack_user_link_access_request_operations
      where request_id = ${approvedFixture.prepared.id}`;
    expect(afterApprovalReplay).toEqual({ status: approved.status, version: approved.version });
    expect(approvalAuditCountAfter).toEqual(approvalAuditCountBefore);
    expect(membershipCountAfter).toEqual(membershipCountBefore);
    expect(linkCountAfter).toEqual(linkCountBefore);
    expect(approvalReceiptAfter).toEqual({ count: approvalReceiptBefore!.count });

    await expect(
      requestSlackUserLinkWorkspaceAccess(db, {
        workspaceId: approvedFixture.target.workspaceId,
        requestId: approvedFixture.prepared.id,
        actorSubjectId: approvedFixture.subjectId,
        expectedVersion: pendingBeforeApproval.version,
        idempotencyKey: approvedKey,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("cancel and expiry never grant or link, and another workspace cannot read the request", async () => {
    if (!available) return;
    const fixture = await preparedFixture("cancel");
    const other = await workspace("other-tenant");
    expect(
      await getSlackUserLinkAccessRequestForSubject(db, {
        workspaceId: other.workspaceId,
        requestId: fixture.prepared.id,
        subjectId: fixture.subjectId,
      }),
    ).toBeNull();

    const cancelled = await cancelSlackUserLinkAccessRequest(db, {
      workspaceId: fixture.target.workspaceId,
      requestId: fixture.prepared.id,
      actorSubjectId: fixture.subjectId,
      expectedVersion: fixture.prepared.version,
      idempotencyKey: randomUUID(),
    });
    expect(cancelled.status).toBe("cancelled");
    const [membership] = await admin<{ count: number }[]>`
      select count(*)::int as count from workspace_memberships
      where workspace_id = ${fixture.target.workspaceId} and subject_id = ${fixture.subjectId}`;
    const link = await getSlackBotUserLink(
      db,
      fixture.target.workspaceId,
      fixture.connection.id,
      "U_cancel",
    );
    expect(membership?.count).toBe(0);
    expect(link).toBeNull();

    const expiredFixture = await preparedFixture("expired");
    const expired = await getSlackUserLinkAccessRequestForSubject(
      db,
      {
        workspaceId: expiredFixture.target.workspaceId,
        requestId: expiredFixture.prepared.id,
        subjectId: expiredFixture.subjectId,
      },
      new Date(expiredFixture.expiresAt.getTime() + 1),
    );
    expect(expired).toMatchObject({ status: "expired", version: 2 });
  });

  test("an existing identity owned by another subject rolls approval back without a membership grant", async () => {
    if (!available) return;
    const fixture = await preparedFixture("conflict");
    const otherSubject = `user:${randomUUID()}`;
    await grantWorkspaceAccess(db, {
      ...fixture.target,
      subjectId: otherSubject,
      permissions: ["sessions:create"],
    });
    await admin`
      insert into slack_bot_user_links
        (account_id, workspace_id, connection_id, slack_team_id, slack_user_id,
         subject_id, linked_by_subject_id)
      values
        (${fixture.target.accountId}, ${fixture.target.workspaceId}, ${fixture.connection.id},
         'T_conflict', 'U_conflict', ${otherSubject}, ${otherSubject})`;
    const pending = await requestSlackUserLinkWorkspaceAccess(db, {
      workspaceId: fixture.target.workspaceId,
      requestId: fixture.prepared.id,
      actorSubjectId: fixture.subjectId,
      expectedVersion: fixture.prepared.version,
      idempotencyKey: randomUUID(),
    });

    await expect(
      approveSlackUserLinkAccessRequest(db, {
        workspaceId: fixture.target.workspaceId,
        requestId: pending.id,
        actorSubjectId: `user:admin-${randomUUID()}`,
        expectedVersion: pending.version,
        idempotencyKey: randomUUID(),
        permissions: ["sessions:create"],
      }),
    ).rejects.toBeInstanceOf(SlackUserLinkAccessPersistenceError);
    const [membership] = await admin<{ count: number }[]>`
      select count(*)::int as count from workspace_memberships
      where workspace_id = ${fixture.target.workspaceId} and subject_id = ${fixture.subjectId}`;
    expect(membership?.count).toBe(0);
    expect(
      await getSlackUserLinkAccessRequestForSubject(db, {
        workspaceId: fixture.target.workspaceId,
        requestId: pending.id,
        subjectId: fixture.subjectId,
      }),
    ).toMatchObject({ status: "pending", version: 2 });
  });

  test("concurrent approvals for one Slack identity choose one subject and roll the loser back", async () => {
    if (!available) return;
    const first = await preparedFixture("approval-race");
    const secondSubjectId = `user:${randomUUID()}`;
    const secondPrepared = await prepareSlackUserLinkAccessRequest(db, {
      ...first.target,
      tokenDigest: digest(`second-race-token-${randomUUID()}`),
      connectionId: first.connection.id,
      slackTeamId: "T_approval-race",
      slackUserId: "U_approval-race",
      subjectId: secondSubjectId,
      subjectLabel: "second-race@example.test",
      expiresAt: first.expiresAt,
    });
    const [firstPending, secondPending] = await Promise.all([
      requestSlackUserLinkWorkspaceAccess(db, {
        workspaceId: first.target.workspaceId,
        requestId: first.prepared.id,
        actorSubjectId: first.subjectId,
        expectedVersion: first.prepared.version,
        idempotencyKey: randomUUID(),
      }),
      requestSlackUserLinkWorkspaceAccess(db, {
        workspaceId: first.target.workspaceId,
        requestId: secondPrepared.id,
        actorSubjectId: secondSubjectId,
        expectedVersion: secondPrepared.version,
        idempotencyKey: randomUUID(),
      }),
    ]);
    const results = await Promise.allSettled([
      approveSlackUserLinkAccessRequest(db, {
        workspaceId: first.target.workspaceId,
        requestId: firstPending.id,
        actorSubjectId: `user:admin-${randomUUID()}`,
        expectedVersion: firstPending.version,
        idempotencyKey: randomUUID(),
        permissions: ["sessions:create"],
      }),
      approveSlackUserLinkAccessRequest(db, {
        workspaceId: first.target.workspaceId,
        requestId: secondPending.id,
        actorSubjectId: `user:admin-${randomUUID()}`,
        expectedVersion: secondPending.version,
        idempotencyKey: randomUUID(),
        permissions: ["sessions:create"],
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [link] = await admin<{ subjectId: string }[]>`
      select subject_id as "subjectId" from slack_bot_user_links
      where connection_id = ${first.connection.id} and slack_user_id = 'U_approval-race'`;
    expect(link).toBeDefined();
    expect([first.subjectId, secondSubjectId]).toContain(link!.subjectId);
    const memberships = await admin<{ subjectId: string }[]>`
      select subject_id as "subjectId" from workspace_memberships
      where workspace_id = ${first.target.workspaceId}
        and subject_id in (${first.subjectId}, ${secondSubjectId})
      order by subject_id`;
    expect([...memberships]).toEqual([{ subjectId: link!.subjectId }]);
  });

  test("a separately granted canonical membership completes the exact prepared request once", async () => {
    if (!available) return;
    const fixture = await preparedFixture("auto-complete");
    await grantWorkspaceAccess(db, {
      ...fixture.target,
      subjectId: fixture.subjectId,
      subjectLabel: "auto-complete@example.test",
      permissions: ["sessions:create"],
    });
    const completed = await completeSlackUserLinkAccessIfGranted(db, {
      workspaceId: fixture.target.workspaceId,
      requestId: fixture.prepared.id,
      subjectId: fixture.subjectId,
    });
    expect(completed).toMatchObject({ status: "completed", version: 2 });
    expect(
      await completeSlackUserLinkAccessIfGranted(db, {
        workspaceId: fixture.target.workspaceId,
        requestId: fixture.prepared.id,
        subjectId: fixture.subjectId,
      }),
    ).toMatchObject({ status: "completed", version: 2 });
    expect(
      await getSlackBotUserLink(
        db,
        fixture.target.workspaceId,
        fixture.connection.id,
        "U_auto-complete",
      ),
    ).toMatchObject({ subjectId: fixture.subjectId });
  });
});
