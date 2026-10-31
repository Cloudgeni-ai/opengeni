import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  UpdateOrganizationWebhookRequest,
  WORKSPACE_WEBHOOK_EVENT_TYPES,
} from "@opengeni/contracts";
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
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const drizzle = new URL("../drizzle/", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

/** The quoted types the newest migration that defines `pattern` lists in it. */
function newestListedTypes(pattern: RegExp): Set<string> {
  const files = readdirSync(drizzle)
    .filter((name) => /^\d+_.*\.sql$/u.test(name))
    .sort();
  for (const name of files.reverse()) {
    const listed = pattern.exec(readFileSync(new URL(name, drizzle), "utf8"))?.[1];
    if (listed) return new Set([...listed.matchAll(/'([a-zA-Z_.]+)'/gu)].map((match) => match[1]!));
  }
  throw new Error(`no migration defines ${pattern}`);
}

// Every type an organization webhook request accepts must be one the
// database stores and sends: a type the request accepts but the check rejects
// fails the create or update with an internal error.
test("organization webhooks store and send every session type their requests accept", () => {
  const check = newestListedTypes(
    /organization_webhooks_event_types_chk CHECK \(([\s\S]*?)\)(?: NOT VALID)?;/u,
  );
  const trigger = newestListedTypes(
    /CREATE TRIGGER session_events_organization_webhook_enqueue_v1[\s\S]*?WHEN \(([\s\S]*?)\)\)/u,
  );
  const accepted = WORKSPACE_WEBHOOK_EVENT_TYPES.filter(
    (type) =>
      UpdateOrganizationWebhookRequest.safeParse({ workspaceFilter: null, eventTypes: [type] })
        .success,
  );
  expect(accepted).toContain("session.agentCall.ringing");
  for (const type of accepted) {
    expect(check).toContain(type);
    if (!type.startsWith("recording.")) expect(trigger).toContain(type);
  }
  // Usage events stay workspace-only.
  for (const type of WORKSPACE_WEBHOOK_EVENT_TYPES.filter((type) => type.startsWith("usage.")))
    expect(check).not.toContain(type);
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

describe("organization webhook agent call events", () => {
  test("an organization endpoint subscribed to agent calls hears the ring and its end", async () => {
    if (!client) return;
    const subjectId = `user:${crypto.randomUUID()}`;
    const access = await bootstrapWorkspace(db(), {
      accountExternalSource: "migration-1211",
      accountExternalId: `account:${crypto.randomUUID()}`,
      accountName: "Organization calls",
      workspaceExternalSource: "migration-1211",
      workspaceExternalId: `workspace:${crypto.randomUUID()}`,
      workspaceName: "Organization calls",
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
    const session = await createSession(db(), {
      ...scope,
      initialMessage: "call me",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId, label: "Ada" },
      createdByContext: { label: "Ada" },
    });
    const organization = await createOrganizationWebhook(db(), {
      accountId: scope.accountId,
      url: "https://example.test/organization-hooks",
      secretEncrypted: "encrypted",
      eventTypes: [
        "session.notification.posted",
        "session.agentCall.ringing",
        "session.agentCall.settled",
      ],
      enabled: true,
      description: null,
      workspaceFilter: null,
      createdBySubjectId: subjectId,
    });
    const callId = crypto.randomUUID();
    await appendSessionEvents(db(), scope.workspaceId, session.id, [
      {
        type: "session.agentCall.ringing",
        payload: { callId, calleeSubjectId: subjectId, reason: "a decision is needed" },
      },
      { type: "session.agentCall.settled", payload: { callId, outcome: "missed" } },
    ]);

    const rows = rowsOf<{ event_type: string; lane: string; data: Record<string, unknown> }>(
      await owned!.admin`
        select event_type, payload->>'lane' as lane, payload->'data' as data
        from organization_webhook_deliveries
        where webhook_id = ${organization.id}::uuid
        order by (payload->>'sequence')::bigint`,
    );
    expect(rows).toEqual([
      {
        event_type: "session.agentCall.ringing",
        lane: "organization",
        data: { callId, calleeSubjectId: subjectId, reason: "a decision is needed" },
      },
      {
        event_type: "session.agentCall.settled",
        lane: "organization",
        data: { callId, outcome: "missed" },
      },
    ]);
  });
});
