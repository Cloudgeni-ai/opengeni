import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  updateOrganizationWebhook,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "1212_organization_webhook_agent_calls.sql";
const migration = readFileSync(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

// Organization endpoints take every session and recording type the contract
// offers; only the usage types stay workspace-only (the API answers 422).
test("1212 lists every non-usage webhook type for organization endpoints", () => {
  const check = /organization_webhooks_event_types_chk CHECK \(([\s\S]*?)\) NOT VALID/u.exec(
    migration,
  )?.[1];
  const trigger = /CREATE TRIGGER session_events_organization_webhook_enqueue_v1[\s\S]*?\)\)/u.exec(
    migration,
  )?.[0];
  for (const type of WORKSPACE_WEBHOOK_EVENT_TYPES) {
    if (type.startsWith("usage.")) expect(check).not.toContain(`'${type}'`);
    else expect(check).toContain(`'${type}'`);
    if (type.startsWith("turn.") || type.startsWith("session.")) {
      expect(trigger).toContain(`'${type}'`);
    }
  }
});

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("organization-webhook-agent-calls");
  if (!owned) {
    if (requireRealDatabase)
      throw new Error("organization webhook agent call PostgreSQL fixture is unavailable");
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

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

describe("organization webhooks and agent calls", () => {
  test("an organization endpoint can subscribe to calls and hears them ring and settle", async () => {
    if (!client) return;
    const subjectId = `user:${crypto.randomUUID()}`;
    const access = await bootstrapWorkspace(db(), {
      accountExternalSource: "migration-1172",
      accountExternalId: `account:${crypto.randomUUID()}`,
      accountName: "Organization calls",
      workspaceExternalSource: "migration-1172",
      workspaceExternalId: `workspace:${crypto.randomUUID()}`,
      workspaceName: "Organization calls",
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
    // An existing endpoint adds the call types, the way a host's deploy reconciles it.
    const webhook = await createOrganizationWebhook(db(), {
      accountId: scope.accountId,
      url: "https://example.test/organization-hooks",
      secretEncrypted: "encrypted",
      eventTypes: ["session.notification.posted"],
      enabled: true,
      description: null,
      workspaceFilter: null,
      createdBySubjectId: subjectId,
    });
    const notificationsOnly = await createOrganizationWebhook(db(), {
      accountId: scope.accountId,
      url: "https://example.test/notifications-only",
      secretEncrypted: "encrypted",
      eventTypes: ["session.notification.posted"],
      enabled: true,
      description: null,
      workspaceFilter: null,
      createdBySubjectId: subjectId,
    });
    await updateOrganizationWebhook(db(), {
      accountId: scope.accountId,
      webhookId: webhook.id,
      eventTypes: [
        "session.notification.posted",
        "session.agentCall.ringing",
        "session.agentCall.settled",
      ],
    });

    const callId = crypto.randomUUID();
    await appendSessionEvents(db(), scope.workspaceId, session.id, [
      {
        type: "session.agentCall.ringing",
        payload: {
          callId,
          calleeSubjectId: subjectId,
          callerLabel: "Deploy watcher",
          reason: "Production is down",
          ringUntil: "2026-10-31T18:00:40.000Z",
          devices: 0,
        },
      },
      {
        type: "session.agentCall.settled",
        payload: {
          callId,
          calleeSubjectId: subjectId,
          reason: "Production is down",
          outcome: "missed",
        },
      },
    ]);

    const rows = rowsOf<{
      webhook_id: string;
      event_type: string;
      payload: { lane: string; data: Record<string, unknown> };
    }>(
      await owned!.admin`
        select webhook_id::text, event_type, payload from organization_webhook_deliveries
        where account_id = ${scope.accountId}::uuid order by (payload->>'sequence')::bigint`,
    );
    expect(rows.map((row) => [row.webhook_id, row.event_type])).toEqual([
      [webhook.id, "session.agentCall.ringing"],
      [webhook.id, "session.agentCall.settled"],
    ]);
    expect(rows.some((row) => row.webhook_id === notificationsOnly.id)).toBe(false);
    expect(rows[0]!.payload.lane).toBe("organization");
    expect(rows[0]!.payload.data).toMatchObject({
      callId,
      calleeSubjectId: subjectId,
      callerLabel: "Deploy watcher",
      reason: "Production is down",
      ringUntil: "2026-10-31T18:00:40.000Z",
    });
    expect(rows[1]!.payload.data).toMatchObject({ callId, outcome: "missed" });
  });
});
