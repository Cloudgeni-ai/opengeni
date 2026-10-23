import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  getSessionInboxRecipient,
  listInboxItems,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "0923_external_user_inbox.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("external-user-inbox");
  if (!owned) {
    if (requireRealDatabase)
      throw new Error("external user inbox PostgreSQL fixture is unavailable");
    return;
  }
  // Owner-run functions and the session-event trigger run under FORCE RLS, as
  // in production.
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 60_000);

const db = () => client!.db;

type Organization = { accountId: string; workspaceId: string };

async function productOrganization(label: string): Promise<Organization> {
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "opengeni:configured",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Product ${label}`,
    workspaceExternalSource: "opengeni:configured",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Product ${label}`,
    subjectId: `user:${crypto.randomUUID()}`,
  });
  return { accountId: access.defaultAccountId!, workspaceId: access.defaultWorkspaceId! };
}

async function sessionIn(organization: Organization, creator: string, label: string) {
  return await createSession(db(), {
    ...organization,
    initialMessage: `initial ${label}`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: creator, label },
    createdByContext: { label },
  });
}

async function askAndNotify(organization: Organization, sessionId: string) {
  await appendSessionEvents(db(), organization.workspaceId, sessionId, [
    {
      type: "session.humanInput.requested",
      payload: {
        request: { id: crypto.randomUUID(), questions: [{ prompt: "Which report?" }] },
      },
    },
    {
      type: "session.notification.posted",
      payload: { key: "report", title: "Report ready", body: "", urgency: "normal" },
    },
  ]);
}

async function itemCount(sessionId: string): Promise<number> {
  const [row] = await owned!.admin<Array<{ count: number }>>`
    select count(*)::int as count from opengeni_private.inbox_items
    where session_id = ${sessionId}`;
  return row?.count ?? 0;
}

describe("0923 external user inbox", () => {
  test("is a rolling migration that keeps both person functions private", async () => {
    if (!client) return;
    const source = await Bun.file(new URL(`../drizzle/${MIGRATION}`, import.meta.url)).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).toContain("SET LOCAL lock_timeout");
    expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
    // The projection and push delivery read the person functions; not replaced.
    expect(source).not.toMatch(/FUNCTION\s+opengeni_private\.enqueue_native_push/i);
    expect(source).not.toMatch(/FUNCTION\s+opengeni_private\.project_inbox_for_session_event_v1/i);
    const rows = await owned!.admin<
      Array<{ name: string; config: string[] | null; publicExecute: boolean }>
    >`
      select procedure.proname as name, procedure.proconfig as config,
        exists (
          select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and procedure.proname in ('session_person_v1', 'session_recipient_v1')
      order by procedure.proname`;
    expect(rows.map((row) => row.name)).toEqual(["session_person_v1", "session_recipient_v1"]);
    for (const row of rows) {
      expect(row.publicExecute).toBe(false);
      expect(row.config?.some((entry) => entry.startsWith("search_path="))).toBe(true);
    }
  });

  test("an external user's sessions reach their inbox", async () => {
    if (!client) return;
    const product = await productOrganization("inbox");
    const external = `external_user:${crypto.randomUUID()}`;
    const session = await sessionIn(product, external, "Product user");
    await askAndNotify(product, session.id);
    const items = await listInboxItems(db(), {
      accountId: product.accountId,
      subjectId: external,
    });
    expect(
      items
        .filter((item) => item.sessionId === session.id)
        .map((item) => item.kind)
        .sort(),
    ).toEqual(["notification", "question"]);
    expect(await getSessionInboxRecipient(db(), product.workspaceId, session.id)).toEqual({
      subjectId: external,
      parentSessionId: null,
    });
  });

  test("keys, services and look-alike subjects still have no inbox", async () => {
    if (!client) return;
    const product = await productOrganization("not-people");
    for (const creator of [
      `apikey:${crypto.randomUUID()}`,
      "scheduler",
      `externalXuser:${crypto.randomUUID()}`,
      `service:external_user:${crypto.randomUUID()}`,
    ]) {
      const session = await sessionIn(product, creator, creator);
      await askAndNotify(product, session.id);
      expect(await itemCount(session.id)).toBe(0);
      expect(await getSessionInboxRecipient(db(), product.workspaceId, session.id)).toBeNull();
    }
  });

  test("the owner keeps precedence over who started the session", async () => {
    if (!client) return;
    const product = await productOrganization("precedence");
    const rows = await owned!.admin<Array<{ person: string | null }>>`
      select opengeni_private.session_person_v1(${product.workspaceId}::uuid,
          gen_random_uuid(), owner, creator) as person
      from (values
        ('external_user:owner', 'user:starter', 1),
        ('user:owner', 'external_user:starter', 2),
        (null, 'external_user:starter', 3),
        ('apikey:x', 'external_user:starter', 4),
        ('externalXuser:owner', 'scheduler', 5)
      ) as cases(owner, creator, position)
      order by position`;
    expect(rows.map((row) => row.person)).toEqual([
      "external_user:owner",
      "user:owner",
      "external_user:starter",
      "external_user:starter",
      null,
    ]);
  });
});
