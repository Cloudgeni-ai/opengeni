import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, recordUsageEvent } from "../src/index";

setDefaultTimeout(120_000);

// Side-feature usage events record where the route that served the call
// processed it: the residency claim only, never evidence. Null means the
// event carried none (recorded before the column, or not a side-feature call).

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("usage-event-processing-residency");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function scope() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "residency",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "residency",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId! };
}

async function stored(idempotencyKey: string) {
  const [row] = await shared.admin<{ residency: unknown }[]>`
    select processing_residency as residency from usage_events
    where idempotency_key = ${idempotencyKey}`;
  return row?.residency;
}

test("a side-feature usage event records the route's claim, never its evidence", async () => {
  const base = await scope();
  const key = `web-search:${crypto.randomUUID()}`;
  await recordUsageEvent(client.db, {
    ...base,
    eventType: "web_search.call",
    quantity: 1,
    unit: "call",
    idempotencyKey: key,
    processingResidency: {
      geography: "eu",
      deploymentType: "self_hosted",
      regions: ["fsn1"],
      evidence: { source: "operator_declaration", reference: "internal-host-name" },
    } as never,
  });
  const residency = await stored(key);
  expect(residency).toEqual({ geography: "eu", deploymentType: "self_hosted", regions: ["fsn1"] });
  expect(JSON.stringify(residency)).not.toContain("internal-host-name");

  const plain = `plain:${crypto.randomUUID()}`;
  await recordUsageEvent(client.db, {
    ...base,
    eventType: "web_search.call",
    quantity: 1,
    unit: "call",
    idempotencyKey: plain,
  });
  expect(await stored(plain)).toBeNull();
});
