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
import { withSessionRlsActorContext } from "../src/database";

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
