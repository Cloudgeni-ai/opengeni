import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
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

const MIGRATION = "0677_local_human_inbox_recipient.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("local-inbox");
  if (!owned) {
    if (requireRealDatabase) throw new Error("local inbox PostgreSQL fixture is unavailable");
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

/** The built-in organization a local install's access bootstrap creates. */
async function localInstall(): Promise<Organization> {
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "opengeni:local",
    accountExternalId: "default",
    accountName: "Local",
    workspaceExternalSource: "opengeni:local",
    workspaceExternalId: "default",
    workspaceName: "Local",
    subjectId: "dev",
    subjectLabel: "Local dev",
  });
  return { accountId: access.defaultAccountId!, workspaceId: access.defaultWorkspaceId! };
}

/** Any other organization whose member happens to be called `dev`. */
async function otherOrganization(label: string): Promise<Organization> {
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "opengeni:configured",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Other ${label}`,
    workspaceExternalSource: "opengeni:configured",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Other ${label}`,
    subjectId: "dev",
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
        request: { id: crypto.randomUUID(), questions: [{ prompt: "Which branch?" }] },
      },
    },
    {
      type: "session.notification.posted",
      payload: { key: "build", title: "Build finished", body: "", urgency: "normal" },
    },
  ]);
}

async function itemCount(sessionId: string): Promise<number> {
  const [row] = await owned!.admin<Array<{ count: number }>>`
    select count(*)::int as count from opengeni_private.inbox_items
    where session_id = ${sessionId}`;
  return row?.count ?? 0;
}

describe("0677 local install inbox recipient", () => {
  test("is a rolling migration that keeps the person function private", async () => {
    if (!client) return;
    const source = await Bun.file(new URL(`../drizzle/${MIGRATION}`, import.meta.url)).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).toContain("SET LOCAL lock_timeout");
    expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
    // Push delivery and the projection are not replaced; they read the person function.
    expect(source).not.toMatch(/FUNCTION\s+opengeni_private\.enqueue_native_push_v1/i);
    expect(source).not.toMatch(/FUNCTION\s+opengeni_private\.project_inbox_for_session_event_v1/i);
    const [row] = await owned!.admin<Array<{ config: string[] | null; publicExecute: boolean }>>`
      select procedure.proconfig as config,
        exists (
          select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private' and procedure.proname = 'session_person_v1'`;
    expect(row?.publicExecute).toBe(false);
    expect(row?.config?.some((entry) => entry.startsWith("search_path="))).toBe(true);
  });

  test("a local install's sessions reach its one human's inbox", async () => {
    if (!client) return;
    const local = await localInstall();
    const session = await sessionIn(local, "dev", "Local dev");
    await askAndNotify(local, session.id);
    const items = await listInboxItems(db(), { accountId: local.accountId, subjectId: "dev" });
    expect(
      items
        .filter((item) => item.sessionId === session.id)
        .map((item) => item.kind)
        .sort(),
    ).toEqual(["notification", "question"]);
    expect(await getSessionInboxRecipient(db(), local.workspaceId, session.id)).toEqual({
      subjectId: "dev",
      parentSessionId: null,
    });
  });

  test("`dev` anywhere but the local organization still has no inbox", async () => {
    if (!client) return;
    const other = await otherOrganization("configured");
    const session = await sessionIn(other, "dev", "Configured dev");
    await askAndNotify(other, session.id);
    expect(await itemCount(session.id)).toBe(0);
    expect(await getSessionInboxRecipient(db(), other.workspaceId, session.id)).toBeNull();
  });

  test("keys and services in the local organization have no inbox", async () => {
    if (!client) return;
    const local = await localInstall();
    for (const creator of [`apikey:${crypto.randomUUID()}`, "scheduler", "internal-update"]) {
      const session = await sessionIn(local, creator, creator);
      await askAndNotify(local, session.id);
      expect(await itemCount(session.id)).toBe(0);
      expect(await getSessionInboxRecipient(db(), local.workspaceId, session.id)).toBeNull();
    }
  });

  test("a person keeps precedence, and only the local organization resolves `dev`", async () => {
    if (!client) return;
    const local = await localInstall();
    const other = await otherOrganization("precedence");
    const rows = await owned!.admin<Array<{ person: string | null }>>`
      select opengeni_private.session_person_v1(workspace_id, gen_random_uuid(), owner, creator)
        as person
      from (values
        (${local.workspaceId}::uuid, null, 'dev', 1),
        (${local.workspaceId}::uuid, 'dev', 'scheduler', 2),
        (${local.workspaceId}::uuid, 'user:owner', 'dev', 3),
        (${local.workspaceId}::uuid, null, 'user:starter', 4),
        (${local.workspaceId}::uuid, 'apikey:x', 'internal-update', 5),
        (${other.workspaceId}::uuid, null, 'dev', 6),
        (${other.workspaceId}::uuid, 'user:owner', 'dev', 7)
      ) as cases(workspace_id, owner, creator, position)
      order by position`;
    expect(rows.map((row) => row.person)).toEqual([
      "dev",
      "dev",
      "user:owner",
      "user:starter",
      null,
      null,
      "user:owner",
    ]);
  });
});
