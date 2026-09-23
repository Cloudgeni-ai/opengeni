import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEventPage,
  withWorkspaceSubjectRls,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-event-page-plan");
  if (!acquired) throw new Error("PostgreSQL required for history plan regression");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("history page plan under named-subject application RLS", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "History plan",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "History",
    subjectId: `history-reader-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await shared.admin`
    insert into session_events (account_id,workspace_id,session_id,sequence,type,payload)
    select ${grant.accountId},${grant.workspaceId},${session.id},n,'agent.message.delta',
      jsonb_build_object('text','synthetic fragment')
    from generate_series(1,15000) n`;
  const otherAccess = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `${suffix}-other`,
    accountName: "Other account",
    workspaceExternalSource: "test",
    workspaceExternalId: `${suffix}-other`,
    workspaceName: "Other history",
    subjectId: `other-reader-${suffix}`,
  });
  const otherGrant = otherAccess.workspaceGrants[0]!;
  const otherSession = await createSession(client.db, {
    accountId: otherGrant.accountId,
    workspaceId: otherGrant.workspaceId,
    initialMessage: "",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await shared.admin`
    insert into session_events (account_id,workspace_id,session_id,sequence,type,payload)
    select ${otherGrant.accountId},${otherGrant.workspaceId},${otherSession.id},n,'agent.message.delta',
      jsonb_build_object('text','other account fragment')
    from generate_series(1,150000) n`;
  // Exercise many sessions in the same authorized workspace, not only one
  // large history per tenant. The target remains the original 15,000 events.
  for (let index = 0; index < 20; index++) {
    const sibling = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "",
      resources: [],
      tools: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await shared.admin`
      insert into session_events (account_id,workspace_id,session_id,sequence,type,payload)
      select ${grant.accountId},${grant.workspaceId},${sibling.id},n,'agent.message.delta',
        jsonb_build_object('text','sibling fragment') from generate_series(1,1500) n`;
  }
  await shared.admin`analyze session_events`;
  for (const direction of ["backward", "forward", "bounded", "type"]) {
    const rows = await withWorkspaceSubjectRls(
      client.db,
      grant.workspaceId,
      grant.subjectId,
      (tx) =>
        tx.execute(sql`
      explain (analyze,buffers,format json)
      select id,sequence,octet_length(row_to_json(e)::text) from session_events e
      where workspace_id=${grant.workspaceId}::uuid and session_id=${session.id}::uuid and sequence>0
        ${direction === "bounded" ? sql`and sequence < 14500` : sql``}
        ${direction === "type" ? sql`and type = 'agent.message.delta'` : sql``}
      order by sequence ${direction === "forward" ? sql`asc` : sql`desc`} limit 256
    `),
    );
    const plan = rows[0]?.["QUERY PLAN"];
    const nodes: Record<string, unknown>[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node["Relation Name"] === "session_events" || node["Node Type"] === "Sort")
        nodes.push({
          node: node["Node Type"],
          rows: node["Actual Rows"],
          estimate: node["Plan Rows"],
          ms: node["Actual Total Time"],
          index: node["Index Name"],
        });
      Object.values(node).forEach(walk);
    };
    walk(plan);
    // Assert bounded work, not wall-clock timing on a shared CI host.
    expect(nodes, direction).toEqual([expect.objectContaining({ node: "Index Scan", rows: 256 })]);
  }
  const tail = await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (tx) =>
    listSessionEventPage(tx, grant.workspaceId, session.id, {
      before: Number.MAX_SAFE_INTEGER,
      limit: 1000,
      payloadMode: "full",
    }),
  );
  expect(tail.events.length).toBe(1000);
  expect(tail.coveredSequence).toEqual({ first: 14001, last: 15000 });
  expect(tail.nextBefore).toBe(14001);
  expect(tail.hasMore).toBe(true);
  expect(
    tail.events.every(
      (event) => (event.payload as { text?: string }).text === "synthetic fragment",
    ),
  ).toBe(true);
  const previous = await withWorkspaceSubjectRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    (tx) =>
      listSessionEventPage(tx, grant.workspaceId, session.id, {
        before: tail.nextBefore!,
        limit: 1000,
        payloadMode: "full",
      }),
  );
  expect(previous.coveredSequence).toEqual({ first: 13001, last: 14000 });
  for (const payloadMode of ["full", "summary", "none"] as const) {
    const page = await withWorkspaceSubjectRls(
      client.db,
      grant.workspaceId,
      grant.subjectId,
      (tx) =>
        listSessionEventPage(tx, grant.workspaceId, session.id, {
          after: 0,
          limit: 255,
          payloadMode,
        }),
    );
    expect(page.coveredSequence).toEqual({ first: 1, last: 255 });
    expect(page.nextAfter).toBe(255);
  }
  const denied = await withWorkspaceSubjectRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    async (tx) => {
      await tx.execute(
        sql`select set_config('opengeni.automatic_session_title_quarantine_v1','1',true)`,
      );
      return tx.execute(
        sql`select id from session_events where workspace_id=${otherGrant.workspaceId}::uuid and session_id=${otherSession.id}::uuid limit 1`,
      );
    },
  );
  expect(denied.length).toBe(0);
}, 180_000);
