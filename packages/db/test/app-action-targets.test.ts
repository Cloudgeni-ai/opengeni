import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import { createDb, type DbClient } from "../src";
import { resolveAppActionTargets, scheduleSummary } from "../src/app-action-targets";

// An app action's approval names what it changes from Opengeni's own records,
// only in the chat's organization and as the person the chat acts for.
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("app-action-targets");
  if (!shared && requireRealDatabase) throw new Error("PostgreSQL test database unavailable");
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function organization(label: string) {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${label}) returning id`;
  const workspace = async (name: string) => {
    const [row] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id`;
    return row!.id;
  };
  return { accountId: account!.id, workspaceId: await workspace("Staging"), workspace };
}

/** A member of the organization and of the workspace. */
async function member(accountId: string, workspaceId: string, role = "member") {
  const subjectId = `user:${crypto.randomUUID()}`;
  const [personal] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, 'Personal') returning id`;
  await shared!.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}, ${subjectId}, ${role}, 'active', ${personal!.id})`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${accountId}, ${workspaceId}, ${subjectId})`;
  return subjectId;
}

async function connection(input: {
  accountId: string;
  workspaceId: string;
  providerDomain: string;
  subjectId?: string | null;
  status?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}) {
  // A personal connection is added by its owner, signed in.
  return await shared!.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${input.accountId}, true),
      set_config('opengeni.workspace_id', ${input.workspaceId}, true),
      set_config('opengeni.subject_id', ${input.subjectId ?? ""}, true)`;
    const [row] = await tx<{ id: string }[]>`
      insert into connections
        (account_id, workspace_id, subject_id, provider_domain, kind, status,
         credential_encrypted, metadata, created_at)
      values (${input.accountId}, ${input.workspaceId}, ${input.subjectId ?? null},
        ${input.providerDomain}, 'oauth2', ${input.status ?? "active"}, 'sealed',
        ${tx.json((input.metadata ?? {}) as never)},
        ${input.createdAt ?? "2026-10-14T07:41:00Z"})
      returning id`;
    return row!.id;
  });
}

const removal = (workspaceId: string, connectionId: string) => ({
  id: "deleteConnection",
  pathParameters: { workspaceId, connectionId },
  body: { expectedVersion: 1 },
});

test("a connection resolves to its integration, account and telling facts", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const person = await member(org.accountId, org.workspaceId);
  await shared!.admin`
    insert into capability_catalog_items (id, kind, name, provider_domain)
    values (${`gmail-${org.accountId}`}, 'mcp', 'Gmail', ${`gmail-${org.accountId}.example`})`;
  const gmail = await connection({
    ...org,
    providerDomain: `gmail-${org.accountId}.example`,
    subjectId: person,
    metadata: { email: "bendik@cloudgeni.ai" },
  });
  const linear = await connection({
    ...org,
    providerDomain: "linear.example",
    status: "needs_reauth",
    metadata: { name: "Bendik", workspaceName: "Cloudgeni" },
    createdAt: "2026-10-02T10:12:00Z",
  });
  const scope = { accountId: org.accountId, subjectId: person };
  expect(await resolveAppActionTargets(client.db, scope, removal(org.workspaceId, gmail))).toEqual({
    workspaceId: { kind: "workspace", name: "Staging" },
    connectionId: {
      kind: "connection",
      name: "Gmail",
      account: "bendik@cloudgeni.ai",
      facts: [
        { label: "Who can use it", value: "Only you" },
        { label: "Added", value: "14 Oct 2026, 07:41 UTC" },
        { label: "Last used", value: "Never" },
      ],
    },
  });
  // No shared catalog name: the provider's domain, never a guess.
  const broken = await resolveAppActionTargets(client.db, scope, removal(org.workspaceId, linear));
  expect(broken.connectionId).toEqual({
    kind: "connection",
    name: "linear.example",
    account: "Bendik · Cloudgeni",
    facts: [
      { label: "Status", value: "Needs reconnecting" },
      { label: "Who can use it", value: "Everyone in this workspace" },
      { label: "Added", value: "2 Oct 2026, 10:12 UTC" },
      { label: "Last used", value: "Never" },
    ],
  });
});

test("what the person can't see, or another organization's, reads as not found", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const other = await organization("Someone else");
  const person = await member(org.accountId, org.workspaceId);
  const theirs = await connection({
    ...org,
    providerDomain: "gmail.example",
    subjectId: await member(org.accountId, org.workspaceId),
    metadata: { email: "colleague@cloudgeni.ai" },
  });
  const foreign = await connection({
    ...other,
    providerDomain: "gmail.example",
    metadata: { email: "stranger@example.com" },
  });
  const scope = { accountId: org.accountId, subjectId: person };
  const colleague = await resolveAppActionTargets(
    client.db,
    scope,
    removal(org.workspaceId, theirs),
  );
  expect(colleague.connectionId).toEqual({ kind: "connection" });
  // The other organization's workspace and its connection: nothing is named.
  const stranger = await resolveAppActionTargets(
    client.db,
    scope,
    removal(other.workspaceId, foreign),
  );
  expect(stranger).toEqual({
    workspaceId: { kind: "workspace" },
    connectionId: { kind: "connection" },
  });
  expect(JSON.stringify(stranger)).not.toContain("stranger");
  // An id that isn't one, or a route without a lookup, names nothing either.
  expect(
    await resolveAppActionTargets(client.db, scope, removal(org.workspaceId, "Gmail")),
  ).toMatchObject({ connectionId: { kind: "connection" } });
  expect(
    await resolveAppActionTargets(client.db, scope, {
      id: "cancelSessionBackgroundCommand",
      pathParameters: {
        workspaceId: org.workspaceId,
        sessionId: crypto.randomUUID(),
        commandId: "x",
      },
    }),
  ).not.toHaveProperty("commandId");
});

test("another workspace in the organization, and a member, are named", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const marketing = await org.workspace("Marketing");
  const subjectId = `user:${crypto.randomUUID()}`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role)
    values (${org.accountId}, ${marketing}, ${subjectId}, 'jorgen@cloudgeni.ai', 'admin')`;
  const targets = await resolveAppActionTargets(
    client.db,
    { accountId: org.accountId, subjectId: null },
    { id: "removeWorkspaceMember", pathParameters: { workspaceId: marketing, subjectId } },
  );
  expect(targets.workspaceId).toEqual({ kind: "workspace", name: "Marketing" });
  expect(targets.subjectId).toMatchObject({
    kind: "member",
    name: "jorgen@cloudgeni.ai",
    facts: [{ label: "Role", value: "Admin" }, { label: "Member since" }],
  });
});

test("schedules read as plain words", () => {
  expect(
    scheduleSummary({
      type: "calendar",
      hour: 8,
      minute: 0,
      timeZone: "Europe/Oslo",
      daysOfWeek: ["MONDAY"],
    }),
  ).toBe("Mondays at 08:00 (Europe/Oslo)");
  expect(scheduleSummary({ type: "calendar", hour: 7, minute: 5, timeZone: "UTC" })).toBe(
    "Every day at 07:05 (UTC)",
  );
  expect(scheduleSummary({ type: "interval", everySeconds: 7200 })).toBe("Every 2 hours");
  expect(scheduleSummary({ type: "manual" })).toBe("Only when started");
  expect(scheduleSummary({ type: "nonsense" })).toBeUndefined();
});

test("every confirmed action's lookup runs against the real schema and says not found plainly", async () => {
  if (!client) return;
  const { ACTION_CATALOG, appActionNeedsConfirmation } =
    await import("@opengeni/contracts/app-actions");
  const { appActionTargetLookupKey } = await import("../src/app-action-targets");
  const org = await organization("Cloudgeni");
  // An owner, who may read every target an action can name.
  const person = await member(org.accountId, org.workspaceId, "owner");
  const failures: string[] = [];
  let checked = 0;
  for (const entry of ACTION_CATALOG.filter(appActionNeedsConfirmation)) {
    const names = [...entry.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]!);
    const pathParameters = Object.fromEntries(
      names.map((name) => [
        name,
        name === "workspaceId"
          ? org.workspaceId
          : name === "organizationId"
            ? org.accountId
            : name === "installationId"
              ? "424242"
              : crypto.randomUUID(),
      ]),
    );
    const targets = await resolveAppActionTargets(
      client.db,
      {
        accountId: org.accountId,
        subjectId: person,
        onLookupError: (error, name) =>
          failures.push(
            `${entry.id} ${name}: ${String((error as { cause?: Error }).cause?.message ?? (error as Error).message).slice(0, 200)}`,
          ),
      },
      { id: entry.id, pathParameters },
    );
    for (const name of names) {
      if (!appActionTargetLookupKey(entry.path, name)) continue;
      checked += 1;
      // Found (the workspace and organization themselves) or plainly not found; never an error.
      if (!targets[name]) failures.push(`${entry.id} ${name}: unresolved`);
      else if (name !== "workspaceId" && name !== "organizationId" && targets[name]!.name)
        failures.push(`${entry.id} ${name}: named ${targets[name]!.name}`);
    }
  }
  expect(failures).toEqual([]);
  expect(checked).toBeGreaterThan(100);
}, 120_000);
