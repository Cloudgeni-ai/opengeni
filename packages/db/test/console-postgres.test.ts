/**
 * Opengeni Console review reads against real PostgreSQL with FORCE RLS:
 * which sessions organization owners and admins can list and open.
 *
 * - shared sessions and end users' private sessions (`external_user:`) in
 *   managed workspaces are reviewable;
 * - an Opengeni account's private ("Only me") chat never is, even in a
 *   managed workspace and even when the caller's own session actor is set;
 * - the metadata level strips content; sub-agent sessions are not listed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  consoleSessionCounts,
  consoleSpendBreakdown,
  consoleSpendByApiKey,
  consoleSpendByWorkspace,
  createDb,
  createSession,
  decodeConsoleSessionCursor,
  getConsoleReviewSettings,
  getConsoleSession,
  isManagedWorkspace,
  listConsoleAuditEvents,
  listConsoleSessions,
  listManagedWorkspaceMarkers,
  markWorkspaceManagedByApiKey,
  recordConsoleAuditEvent,
  recordConsoleAuditEventOnce,
  rememberEndUserLabel,
  setConsoleReviewLevel,
  setConsoleWorkspaceKind,
} from "../src/index";
import { sql } from "drizzle-orm";
import { consoleSessionSpendSql } from "../src/console";
import {
  rawRows,
  withAccountRls,
  withoutSessionRlsActor,
  withSessionRlsActorContext,
} from "../src/database";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("opengeni-console");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function organization() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "console",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Product tenant",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const managedId = grant.workspaceId!;
  const teamId = crypto.randomUUID();
  await shared.admin`insert into workspaces (id, account_id, name)
    values (${teamId}, ${accountId}, 'Team')`;
  return { accountId, managedId, teamId, adminSubjectId: grant.subjectId };
}

async function session(
  accountId: string,
  workspaceId: string,
  options: {
    title: string;
    ownerSubjectId?: string;
    parentSessionId?: string;
    siteVisitor?: boolean;
  } = { title: "" },
) {
  const created = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set title = ${options.title} where id = ${created.id}`;
    if (options.ownerSubjectId) {
      const personal = crypto.randomUUID();
      await tx`insert into workspaces (id, account_id, name) values (${personal}, ${accountId}, 'Personal')`;
      await tx`insert into organization_memberships
          (account_id, subject_id, role, status, personal_workspace_id)
        values (${accountId}, ${options.ownerSubjectId}, 'member', 'active', ${personal})
        on conflict do nothing`;
      await tx`update sessions set visibility = 'user_private',
          owner_subject_id = ${options.ownerSubjectId}, created_by_subject_id = ${options.ownerSubjectId},
          owner_organization_membership_id = (select id from organization_memberships
            where account_id = ${accountId} and subject_id = ${options.ownerSubjectId})
        where id = ${created.id}`;
    }
    if (options.siteVisitor) {
      // A Site visitor's conversation is stored workspace-shared but is theirs alone.
      await tx`update sessions set site_access_root_id = ${crypto.randomUUID()} where id = ${created.id}`;
    }
    if (options.parentSessionId) {
      await tx`update sessions set parent_session_id = ${options.parentSessionId},
          root_session_id = ${options.parentSessionId}
        where id = ${created.id}`;
    }
  });
  return created.id;
}

test("owners and admins review shared and end-user sessions, never Only me chats of Opengeni accounts", async () => {
  const { accountId, managedId, teamId } = await organization();
  await markWorkspaceManagedByApiKey(client.db, {
    accountId,
    workspaceId: managedId,
    apiKeyId: crypto.randomUUID(),
  });
  expect(await isManagedWorkspace(client.db, accountId, managedId)).toBe(true);
  expect(await isManagedWorkspace(client.db, accountId, teamId)).toBe(false);

  const endUser = `external_user:${crypto.randomUUID()}`;
  const sharedId = await session(accountId, managedId, { title: "Shared question" });
  const endUserId = await session(accountId, managedId, {
    title: "End user question",
    ownerSubjectId: endUser,
  });
  const onlyMeId = await session(accountId, managedId, {
    title: "Only me chat",
    ownerSubjectId: `user:${crypto.randomUUID()}`,
  });
  await session(accountId, managedId, { title: "Sub-agent", parentSessionId: sharedId });
  await session(accountId, managedId, { title: "Site visitor", siteVisitor: true });
  await shared.admin`insert into feedback_submissions
      (account_id, workspace_id, subject_id, principal_kind, idempotency_key, session_id, sentiment)
    values (${accountId}, ${managedId}, ${endUser}, 'external_user', ${crypto.randomUUID()},
      ${endUserId}, 'negative')`;
  await rememberEndUserLabel(client.db, {
    accountId,
    subjectId: endUser,
    source: "product",
    externalId: "customer-42",
  });

  const workspaces = [{ id: managedId, name: "Product tenant" }];
  // The reader's own session actor (an admin's subject) must not narrow or
  // widen what Console sees.
  const list = await withSessionRlsActorContext({ subjectId: "user:admin-reader" }, () =>
    listConsoleSessions(client.db, {
      accountId,
      workspaces,
      limit: 50,
      cursor: null,
      q: null,
      includeContent: true,
    }),
  );
  const ids = list.sessions.map((entry) => entry.id).sort();
  expect(ids).toEqual([sharedId, endUserId].sort());
  const endUserEntry = list.sessions.find((entry) => entry.id === endUserId)!;
  expect(endUserEntry).toMatchObject({
    title: "End user question",
    visibility: "private",
    endUser: { subjectId: endUser, externalId: "customer-42", source: "product" },
    feedback: { positive: 0, negative: 1 },
  });

  expect(
    await getConsoleSession(client.db, {
      accountId,
      workspace: workspaces[0]!,
      sessionId: onlyMeId,
      includeContent: true,
    }),
  ).toBeNull();
  const detail = await getConsoleSession(client.db, {
    accountId,
    workspace: workspaces[0]!,
    sessionId: endUserId,
    includeContent: false,
  });
  expect(detail?.summary.title).toBeNull();
  expect(detail?.summary.firstMessage).toBeNull();

  const searched = await listConsoleSessions(client.db, {
    accountId,
    workspaces,
    limit: 50,
    cursor: null,
    q: "only me",
    includeContent: true,
  });
  expect(searched.sessions).toEqual([]);

  // One row per page walks every reviewable session exactly once.
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof listConsoleSessions>> = await listConsoleSessions(
      client.db,
      {
        accountId,
        workspaces,
        limit: 1,
        cursor: cursor ? decodeConsoleSessionCursor(cursor) : null,
        q: null,
        includeContent: false,
      },
    );
    seen.push(...page.sessions.map((entry) => entry.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen.sort()).toEqual([sharedId, endUserId].sort());

  const counts = await consoleSessionCounts(
    client.db,
    accountId,
    [managedId, teamId],
    { since: new Date(Date.now() - 86_400_000).toISOString(), until: new Date().toISOString() },
    { endUsersFor: new Set([managedId]) },
  );
  // Only me and Site visitor chats are not counted either.
  expect(counts.sessions.get(managedId)).toBe(2);
  expect(counts.sessions.get(teamId)).toBe(0);
  expect(counts.endUsers).toBe(1);
});

test("review level, workspace kind and the audit log", async () => {
  const { accountId, managedId, adminSubjectId } = await organization();
  expect((await getConsoleReviewSettings(client.db, accountId)).reviewLevel).toBe("full");
  await setConsoleReviewLevel(client.db, {
    accountId,
    reviewLevel: "metadata",
    actorSubjectId: adminSubjectId,
    actorLabel: "Admin",
  });
  expect((await getConsoleReviewSettings(client.db, accountId)).reviewLevel).toBe("metadata");

  await setConsoleWorkspaceKind(client.db, {
    accountId,
    workspaceId: managedId,
    kind: "managed",
    actorSubjectId: adminSubjectId,
    actorLabel: "Admin",
  });
  expect((await listManagedWorkspaceMarkers(client.db, accountId)).get(managedId)?.source).toBe(
    "console",
  );
  await setConsoleWorkspaceKind(client.db, {
    accountId,
    workspaceId: managedId,
    kind: "team",
    actorSubjectId: adminSubjectId,
    actorLabel: "Admin",
  });
  expect(await isManagedWorkspace(client.db, accountId, managedId)).toBe(false);

  const sessionId = crypto.randomUUID();
  const viewedId = await recordConsoleAuditEvent(client.db, {
    accountId,
    actorSubjectId: adminSubjectId,
    actorLabel: "Admin",
    action: "session.transcript_viewed",
    workspaceId: managedId,
    sessionId,
    detail: {},
  });
  // Paging the transcript right after opening it reuses the open's entry.
  expect(
    await recordConsoleAuditEventOnce(client.db, {
      accountId,
      actorSubjectId: adminSubjectId,
      actorLabel: "Admin",
      action: "session.transcript_viewed",
      workspaceId: managedId,
      sessionId,
      detail: {},
    }),
  ).toBe(viewedId);
  const first = await listConsoleAuditEvents(client.db, { accountId, limit: 2 });
  expect(first.events.map((event) => event.action)).toEqual([
    "session.transcript_viewed",
    "workspace.kind_changed",
  ]);
  const rest = await listConsoleAuditEvents(client.db, {
    accountId,
    limit: 10,
    cursor: first.nextCursor!,
  });
  expect(rest.events.map((event) => event.action)).toEqual([
    "workspace.kind_changed",
    "settings.review_level_changed",
  ]);
  const bySession = await listConsoleAuditEvents(client.db, { accountId, limit: 10, sessionId });
  expect(bySession.events).toHaveLength(1);

  // The runtime role can only append to the audit log.
  await expect(
    (async () =>
      await client.db.execute(
        sql`update organization_console_audit_events set action = 'session.metadata_viewed'`,
      ))(),
  ).rejects.toThrow();

  expect(
    (
      await consoleSpendByWorkspace(client.db, accountId, {
        since: new Date(Date.now() - 86_400_000).toISOString(),
        until: new Date().toISOString(),
      })
    ).size,
  ).toBe(0);
});

test("top models count billed calls and their tokens once per call", async () => {
  const { accountId, managedId } = await organization();
  const call = (
    sourceId: string,
    amount: number,
    tokens: { inputTokens: number; outputTokens: number; cachedTokens: number } | null,
    key: string,
    type = "model_usage_debit",
  ) => shared.admin`insert into credit_ledger_entries
      (account_id, workspace_id, type, amount_micros, source_type, source_id, idempotency_key, metadata)
    values (${accountId}, ${managedId}, ${type}, ${amount}, 'model_response', ${sourceId}, ${key},
      ${shared.admin.json({ model: "gpt-6-luna", ...(tokens ?? {}) })})`;
  const tokens = { inputTokens: 1200, outputTokens: 300, cachedTokens: 800 };
  // One call debited from promotional and paid credit: one call, its tokens once.
  await call("resp_1", -1_500, tokens, `${accountId}:1a`);
  await call("resp_1", -971, tokens, `${accountId}:1b`);
  await call(
    "resp_2",
    -2_000,
    { inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
    `${accountId}:2`,
  );
  const breakdown = await consoleSpendBreakdown(client.db, accountId, {
    since: new Date(Date.now() - 86_400_000).toISOString(),
    until: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(breakdown.byModel).toEqual([
    {
      model: "gpt-6-luna",
      spendMicros: 4_471,
      calls: 2,
      inputTokens: 1_300,
      outputTokens: 350,
      cachedTokens: 800,
    },
  ]);
});

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
};
function planNodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
}

test("session cost sums each tree's debits through the ledger's idempotency index", async () => {
  const { accountId, managedId, teamId } = await organization();
  const apiKeyId = crypto.randomUUID();
  await markWorkspaceManagedByApiKey(client.db, { accountId, workspaceId: managedId, apiKeyId });
  await markWorkspaceManagedByApiKey(client.db, { accountId, workspaceId: teamId, apiKeyId });
  const rootId = await session(accountId, managedId, { title: "Root" });
  const childId = await session(accountId, managedId, {
    title: "Sub-agent",
    parentSessionId: rootId,
  });
  const otherId = await session(accountId, managedId, {
    title: "End user",
    ownerSubjectId: `external_user:${crypto.randomUUID()}`,
  });
  const idleId = await session(accountId, managedId, { title: "No calls" });

  const call = async (
    sessionId: string,
    debits: { type: "model_usage_debit" | "byok_platform_fee"; amount: number }[],
  ) => {
    const turnId = crypto.randomUUID();
    const sourceKey = `resp_${crypto.randomUUID()}`;
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into model_call_facts (account_id, workspace_id, session_id, turn_id, source_key,
          provider, provider_api, model, billing_path, occurred_at)
        values (${accountId}, ${managedId}, ${sessionId}, ${turnId}, ${sourceKey},
          'openai', 'responses', 'gpt-6-luna', 'opengeni_credits', now())`;
      for (const debit of debits) {
        await tx`insert into credit_ledger_entries
            (account_id, workspace_id, type, amount_micros, source_type, source_id, idempotency_key)
          values (${accountId}, ${managedId}, ${debit.type}, ${debit.amount}, 'model_response',
            ${sourceKey}, ${`credit:${debit.type}:${turnId}:${sourceKey}`})`;
      }
    });
  };
  // A root's cost includes its sub-agents and BYOK platform fees.
  await call(rootId, [
    { type: "model_usage_debit", amount: -1_000 },
    { type: "byok_platform_fee", amount: -200 },
  ]);
  await call(childId, [{ type: "model_usage_debit", amount: -300 }]);
  await call(otherId, [{ type: "model_usage_debit", amount: -700 }]);
  // A call without a debit (included or failed) costs nothing.
  await call(otherId, []);
  // Spend in another managed workspace of the same key, and a large ledger
  // of unrelated rows the per-session lookups must not scan.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into credit_ledger_entries
        (account_id, workspace_id, type, amount_micros, idempotency_key)
      values (${accountId}, ${teamId}, 'model_usage_debit', -400, ${`team:${crypto.randomUUID()}`})`;
    await tx`insert into credit_ledger_entries
        (account_id, workspace_id, type, amount_micros, source_type, source_id, idempotency_key)
      select gen_random_uuid(), gen_random_uuid(), 'model_usage_debit', -1, 'model_response',
        'filler', 'credit:model_usage_debit:' || gen_random_uuid() || ':filler-' || n
      from generate_series(1, 10000) n`;
    await tx`analyze credit_ledger_entries`;
  });

  const page = await listConsoleSessions(client.db, {
    accountId,
    workspaces: [{ id: managedId, name: "Product tenant" }],
    limit: 50,
    cursor: null,
    q: null,
    includeContent: false,
  });
  const costs = new Map(page.sessions.map((entry) => [entry.id, entry.costMicros]));
  expect(costs).toEqual(
    new Map([
      [rootId, 1_500],
      [otherId, 700],
      [idleId, 0],
    ]),
  );
  const detail = await getConsoleSession(client.db, {
    accountId,
    workspace: { id: managedId, name: "Product tenant" },
    sessionId: rootId,
    includeContent: false,
  });
  expect(detail?.summary.costMicros).toBe(1_500);

  const window = {
    since: new Date(Date.now() - 86_400_000).toISOString(),
    until: new Date(Date.now() + 60_000).toISOString(),
  };
  expect(await consoleSpendByApiKey(client.db, accountId, window)).toEqual([
    { apiKeyId, workspaces: 2, spendMicros: 2_600 },
  ]);

  // Under the Console's row-level security scope, the ledger is probed by its
  // unique idempotency key, never scanned.
  const [explained] = await withoutSessionRlsActor(() =>
    withAccountRls(client.db, accountId, async (tx) => {
      await tx.execute(sql`select set_config('opengeni.console_review', 'on', true),
        set_config('opengeni.workspace_id', ${managedId}, true)`);
      return await rawRows<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
        tx,
        sql`explain (format json) ${consoleSessionSpendSql(accountId, managedId, [rootId, otherId, idleId])}`,
      );
    }),
  );
  const ledgerReads = planNodes(explained!["QUERY PLAN"][0].Plan).filter(
    (node) => node["Relation Name"] === "credit_ledger_entries",
  );
  expect(ledgerReads.length).toBeGreaterThan(0);
  for (const read of ledgerReads) {
    expect(read["Node Type"]).toMatch(/^Index (Only )?Scan$/);
    expect(read["Index Name"]).toBe("credit_ledger_entries_idempotency_idx");
  }
});
