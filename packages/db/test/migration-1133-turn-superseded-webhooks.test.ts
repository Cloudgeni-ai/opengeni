import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { WORKSPACE_WEBHOOK_EVENT_TYPES } from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createOrganizationWebhook,
  createSession,
  createWorkspaceWebhook,
  withRlsContext,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "1133_turn_superseded_webhooks.sql";
const migration = readFileSync(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

// The check constraint and both triggers list every session webhook type the
// contract offers, so a later type cannot be subscribable but never sent.
test("1133 lists turn.superseded wherever the turn types are listed", () => {
  const workspaceCheck = /workspace_webhooks_event_types_chk CHECK \(([\s\S]*?)\) NOT VALID/u.exec(
    migration,
  )?.[1];
  for (const type of WORKSPACE_WEBHOOK_EVENT_TYPES) {
    expect(workspaceCheck).toContain(`'${type}'`);
  }
  const triggers = [
    ...migration.matchAll(/CREATE TRIGGER (session_events_\w+_webhook_enqueue_v1)[\s\S]*?\)\)/gu),
  ];
  expect(triggers.map((match) => match[1])).toEqual([
    "session_events_workspace_webhook_enqueue_v1",
    "session_events_organization_webhook_enqueue_v1",
  ]);
  for (const [trigger] of triggers) expect(trigger).toContain("'turn.superseded'");
});

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("turn-superseded-webhooks");
  if (!owned) {
    if (requireRealDatabase)
      throw new Error("turn superseded webhook PostgreSQL fixture is unavailable");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 60_000);

const db = () => client!.db;

type Delivery = {
  webhook_id: string;
  event_type: string;
  payload: { type: string; turnId: string | null; data: Record<string, unknown> };
};

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

describe("turn.superseded webhooks", () => {
  test("an endpoint subscribed to turn.superseded hears about a turn a Steer took over", async () => {
    if (!client) return;
    const subjectId = `user:${crypto.randomUUID()}`;
    const access = await bootstrapWorkspace(db(), {
      accountExternalSource: "migration-1133",
      accountExternalId: `account:${crypto.randomUUID()}`,
      accountName: "Superseded turns",
      workspaceExternalSource: "migration-1133",
      workspaceExternalId: `workspace:${crypto.randomUUID()}`,
      workspaceName: "Superseded turns",
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
    const session = await createSession(db(), {
      ...scope,
      initialMessage: "first message",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId, label: "Ada" },
      createdByContext: { label: "Ada" },
    });
    const webhook = (eventTypes: string[]) =>
      createWorkspaceWebhook(db(), {
        ...scope,
        url: "https://example.test/hooks",
        secretEncrypted: "encrypted",
        eventTypes,
        enabled: true,
        description: null,
        createdBySubjectId: subjectId,
      });
    const allTerminal = await webhook([
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "turn.superseded",
    ]);
    const cancelledOnly = await webhook(["turn.cancelled"]);
    const organization = await createOrganizationWebhook(db(), {
      accountId: scope.accountId,
      url: "https://example.test/organization-hooks",
      secretEncrypted: "encrypted",
      eventTypes: ["turn.superseded"],
      enabled: true,
      description: null,
      workspaceFilter: null,
      createdBySubjectId: subjectId,
    });
    // The trigger routes events by type; the turns need no rows of their own here.
    const interrupted = crypto.randomUUID();
    const stopped = crypto.randomUUID();
    await appendSessionEvents(db(), scope.workspaceId, session.id, [
      { type: "turn.superseded", turnId: interrupted, payload: { reason: "steer" } },
      { type: "turn.cancelled", turnId: stopped, payload: { reason: "session_cancelled" } },
    ]);

    const workspaceRows = await withRlsContext(db(), scope, async (scoped) =>
      rowsOf<Delivery>(
        await scoped.execute(
          sql`select webhook_id::text, event_type, payload from workspace_webhook_deliveries
            where workspace_id = ${scope.workspaceId}::uuid
            order by (payload->>'sequence')::bigint, webhook_id`,
        ),
      ),
    );
    const deliveredTo = (webhookId: string) =>
      workspaceRows
        .filter((row) => row.webhook_id === webhookId)
        .map((row) => [row.event_type, row.payload.turnId, row.payload.data.reason]);
    expect(deliveredTo(allTerminal.id)).toEqual([
      ["turn.superseded", interrupted, "steer"],
      ["turn.cancelled", stopped, "session_cancelled"],
    ]);
    // An existing registration is unchanged: it still gets only what it chose.
    expect(deliveredTo(cancelledOnly.id)).toEqual([
      ["turn.cancelled", stopped, "session_cancelled"],
    ]);
    const superseded = workspaceRows.find((row) => row.event_type === "turn.superseded")!;
    expect(superseded.payload).toMatchObject({ type: "turn.superseded", turnId: interrupted });
    expect(superseded.payload).toHaveProperty("initiatingHuman");

    const organizationRows = rowsOf<{ event_type: string; turn_id: string }>(
      await owned!.admin`
        select event_type, payload->>'turnId' as turn_id from organization_webhook_deliveries
        where webhook_id = ${organization.id}::uuid`,
    );
    expect(organizationRows).toEqual([{ event_type: "turn.superseded", turn_id: interrupted }]);
  });
});
