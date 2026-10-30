import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import { createDb, createRig, createWorkspace, type DbClient } from "../src";
import {
  resolveAppActionTargets,
  savedAppActionApprovalCard,
  scheduleSummary,
} from "../src/app-action-targets";

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

/**
 * A member of the organization, with a role there, and of the workspace,
 * with the permissions the API's workspace grant reads (its role label is
 * only a label).
 */
async function member(
  accountId: string,
  workspaceId: string,
  role = "member",
  permissions: string[] = ["workspace:read"],
  workspaceRole = "member",
) {
  const subjectId = `user:${crypto.randomUUID()}`;
  const [personal] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, 'Personal') returning id`;
  await shared!.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}, ${subjectId}, ${role}, 'active', ${personal!.id})`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${workspaceId}, ${subjectId}, ${workspaceRole},
      ${shared!.admin.json(permissions)})`;
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
  const person = await member(org.accountId, org.workspaceId, "member", [
    "workspace:read",
    "connections:read",
  ]);
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
  const scope = { accountId: org.accountId, workspaceId: org.workspaceId, subjectId: person };
  expect(await resolveAppActionTargets(client.db, scope, removal(org.workspaceId, gmail))).toEqual({
    // The chat's own workspace is "this workspace", with no lookup.
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

test("what the person can't see reads as not found; another organization's stays unresolved", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const other = await organization("Someone else");
  const person = await member(org.accountId, org.workspaceId, "member", [
    "workspace:read",
    "connections:read",
  ]);
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
  const scope = { accountId: org.accountId, workspaceId: org.workspaceId, subjectId: person };
  const colleague = await resolveAppActionTargets(
    client.db,
    scope,
    removal(org.workspaceId, theirs),
  );
  expect(colleague.connectionId).toEqual({ kind: "connection" });
  // The other organization's workspace and its connection may exist: nothing
  // is named, and nothing is called not found.
  const stranger = await resolveAppActionTargets(
    client.db,
    scope,
    removal(other.workspaceId, foreign),
  );
  expect(stranger).toEqual({});
  expect(JSON.stringify(stranger)).not.toContain("stranger");
  // Nor is an id that isn't one, there: the workspace is checked first.
  expect(
    await resolveAppActionTargets(client.db, scope, removal(other.workspaceId, "Gmail")),
  ).toEqual({});
  // Someone whose role can't read connections sees none named, nor "not found".
  const viewer = await member(org.accountId, org.workspaceId);
  expect(
    await resolveAppActionTargets(
      client.db,
      { ...scope, subjectId: viewer },
      removal(org.workspaceId, theirs),
    ),
  ).toEqual({});
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

test("another workspace is named only for someone who acts in it", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const marketing = await org.workspace("Marketing");
  const subjectId = `user:${crypto.randomUUID()}`;
  await shared!.admin`
    insert into workspace_memberships
      (account_id, workspace_id, subject_id, subject_label, role, permissions)
    values (${org.accountId}, ${marketing}, ${subjectId}, 'jorgen@cloudgeni.ai', 'admin',
      ${shared!.admin.json(["workspace:admin"])})`;
  const call = {
    id: "removeWorkspaceMember",
    pathParameters: { workspaceId: marketing, subjectId },
  };
  // A member of Staging only: Marketing's name and members stay unresolved.
  const outsider = await member(org.accountId, org.workspaceId);
  const scope = { accountId: org.accountId, workspaceId: org.workspaceId, subjectId: outsider };
  expect(await resolveAppActionTargets(client.db, scope, call)).toEqual({});
  // A workspace admin of Staging is still an outsider to Marketing.
  const stagingAdmin = await member(org.accountId, org.workspaceId, "member", ["workspace:admin"]);
  expect(
    await resolveAppActionTargets(client.db, { ...scope, subjectId: stagingAdmin }, call),
  ).toEqual({});
  // Nor is an organization owner who isn't a member: admins' pages list
  // workspaces but not members' Personal ones, which a lookup can't tell apart.
  const owner = await member(org.accountId, org.workspaceId, "owner");
  expect(await resolveAppActionTargets(client.db, { ...scope, subjectId: owner }, call)).toEqual(
    {},
  );
  // A member of Marketing sees it as the API does.
  const targets = await resolveAppActionTargets(client.db, { ...scope, subjectId }, call);
  expect(targets.workspaceId).toEqual({ kind: "workspace", name: "Marketing" });
  expect(targets.subjectId).toMatchObject({
    kind: "member",
    name: "jorgen@cloudgeni.ai",
    facts: [{ label: "Role", value: "Admin" }, { label: "Member since" }],
  });
  // Without a person nothing is read at all.
  expect(await resolveAppActionTargets(client.db, { ...scope, subjectId: null }, call)).toEqual({});
});

test("a colleague's Only me Site or schedule is never named; shared ones and your own are", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const person = await member(org.accountId, org.workspaceId, "member", [
    "workspace:read",
    "artifacts:read",
    "scheduled_tasks:run",
  ]);
  const colleague = await member(org.accountId, org.workspaceId);
  const site = async (title: string, owner: string | null) => {
    const [row] = await shared!.admin<{ id: string }[]>`
      insert into workspace_artifacts
        (account_id, workspace_id, slug, title, created_by_subject_id, visibility, owner_subject_id)
      values (${org.accountId}, ${org.workspaceId}, ${`s-${crypto.randomUUID().slice(0, 8)}`},
        ${title}, ${owner ?? person}, ${owner ? "user_private" : "workspace_shared"}, ${owner})
      returning id`;
    return row!.id;
  };
  // A schedule's owner is the person who created it, signed in.
  const schedule = async (name: string, owner: string | null) =>
    await shared!.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.initiating_human_subject_id', ${owner ?? ""}, true)`;
      const [row] = await tx<{ id: string }[]>`
        insert into scheduled_tasks
          (account_id, workspace_id, name, schedule, temporal_schedule_id, agent_config,
           execution_digest, visibility, owner_subject_id, created_by_kind, created_by_subject_id)
        values (${org.accountId}, ${org.workspaceId}, ${name},
          ${tx.json({ type: "manual" })}, ${`t-${crypto.randomUUID()}`}, ${tx.json({})},
          ${"d".repeat(64)}, ${owner ? "user_private" : "workspace_shared"}, ${owner},
          'subject', ${owner ?? person})
        returning id`;
      return row!.id;
    });
  const scope = { accountId: org.accountId, workspaceId: org.workspaceId, subjectId: person };
  const unpublish = (artifactId: string) => ({
    id: "DELETE /v1/workspaces/:workspaceId/published-artifacts/:artifactId/publication",
    pathParameters: { workspaceId: org.workspaceId, artifactId },
  });
  const removeSchedule = (taskId: string) => ({
    id: "deleteScheduledTask",
    pathParameters: { workspaceId: org.workspaceId, taskId },
  });
  const named = async (call: unknown, parameter: string) =>
    (await resolveAppActionTargets(client!.db, scope, call))[parameter];
  expect(await named(unpublish(await site("Roadmap", null)), "artifactId")).toMatchObject({
    kind: "Site",
    name: "Roadmap",
  });
  expect(await named(unpublish(await site("My notes", person)), "artifactId")).toMatchObject({
    name: "My notes",
  });
  const secret = await named(unpublish(await site("Layoff plan Q4", colleague)), "artifactId");
  expect(secret).toEqual({ kind: "Site" });
  expect(await named(removeSchedule(await schedule("Daily digest", null)), "taskId")).toMatchObject(
    {
      kind: "scheduled task",
      name: "Daily digest",
      facts: expect.arrayContaining([{ label: "Runs", value: "Only when started" }]),
    },
  );
  expect(
    await named(removeSchedule(await schedule("Their reminders", colleague)), "taskId"),
  ).toEqual({ kind: "scheduled task" });
  // A viewer, whose role can't use schedules, sees even a shared one unnamed.
  const viewer = await member(org.accountId, org.workspaceId);
  expect(
    (
      await resolveAppActionTargets(
        client.db,
        { ...scope, subjectId: viewer },
        removeSchedule(await schedule("Payroll run", null)),
      )
    ).taskId,
  ).toBeUndefined();
  // An admin's pause of a colleague's private task reads through rules a
  // lookup can't copy: unresolved, never a false "not found".
  expect(
    await resolveAppActionTargets(client.db, scope, {
      id: "pausePrivateScheduledTask",
      pathParameters: {
        workspaceId: org.workspaceId,
        taskId: await schedule("Their reminders", colleague),
      },
    }),
  ).toEqual({});
});

test("organization keys, others' keys and webhooks need the role their routes need; webhooks show only their host", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const person = await member(org.accountId, org.workspaceId);
  const colleague = `user:${crypto.randomUUID()}`;
  const key = async (kind: "organization" | "personal", owner: string | null, name: string) => {
    const [row] = await shared!.admin<{ id: string }[]>`
      insert into api_keys
        (account_id, name, prefix, key_hash, credential_kind, permission_mode, owner_subject_id,
         owner_permissions)
      values (${org.accountId}, ${name}, 'og_ab12', ${crypto.randomUUID()}, ${kind}, 'explicit',
        ${owner}, ${owner ? shared!.admin.json([]) : null})
      returning id`;
    return row!.id;
  };
  const orgKey = await key("organization", null, "CI deploy key");
  const mine = await key("personal", person, "My laptop");
  const theirs = await key("personal", colleague, "Their laptop");
  const [workspaceKey] = await shared!.admin<{ id: string }[]>`
    insert into api_keys (account_id, workspace_id, name, prefix, key_hash, credential_kind)
    values (${org.accountId}, ${org.workspaceId}, 'Workspace deploy key', 'og_ww12',
      ${crypto.randomUUID()}, 'workspace')
    returning id`;
  const [hook] = await shared!.admin<{ id: string }[]>`
    insert into organization_webhooks (account_id, url, secret_encrypted, event_types)
    values (${org.accountId}, 'https://hooks.slack.com/services/T000/B000/s3cretpath', 'sealed',
      ${["turn.completed"]})
    returning id`;
  const call = (id: string, parameter: string, value: string) => ({
    id,
    pathParameters: { organizationId: org.accountId, [parameter]: value },
  });
  const member_ = { accountId: org.accountId, workspaceId: org.workspaceId, subjectId: person };
  // Only the owner role holds account:admin and api_keys:manage.
  const admin = { ...member_, subjectId: await member(org.accountId, org.workspaceId, "owner") };
  const organizationAdmin = {
    ...member_,
    subjectId: await member(org.accountId, org.workspaceId, "admin"),
  };
  // A workspace admin whose organization role is member: the turn's frozen
  // grant can imply account:admin for them, but the API's routes don't.
  const workspaceAdmin = {
    ...member_,
    subjectId: await member(org.accountId, org.workspaceId, "member", ["workspace:admin"]),
  };
  const read = async (scope: typeof member_, value: ReturnType<typeof call>, parameter: string) =>
    (await resolveAppActionTargets(client!.db, scope, value))[parameter];
  const deleteOrgKey = call("deleteOrganizationApiKey", "apiKeyId", orgKey);
  const revokeMine = call("revokePersonalApiKey", "apiKeyId", mine);
  const revokeTheirs = call("revokePersonalApiKey", "apiKeyId", theirs);
  const deleteHook = call("deleteOrganizationWebhook", "webhookId", hook!.id);
  // A member: their own key only.
  expect(await read(member_, deleteOrgKey, "apiKeyId")).toBeUndefined();
  expect(await read(member_, revokeMine, "apiKeyId")).toMatchObject({ name: "My laptop" });
  expect(await read(member_, revokeTheirs, "apiKeyId")).toBeUndefined();
  expect(await read(member_, deleteHook, "webhookId")).toBeUndefined();
  // Each route reads only its own kind of key, as the API's do: their own
  // key on the organization-key route is not theirs to name there.
  expect(
    await read(member_, call("deleteOrganizationApiKey", "apiKeyId", mine), "apiKeyId"),
  ).toBeUndefined();
  for (const id of ["deleteOrganizationApiKey", "revokePersonalApiKey"]) {
    const other = call(id, "apiKeyId", workspaceKey!.id);
    expect(await read(admin, other, "apiKeyId")).toEqual({ kind: "API key" });
    expect(await read(member_, other, "apiKeyId")).toBeUndefined();
  }
  expect(await read(admin, call("revokePersonalApiKey", "apiKeyId", orgKey), "apiKeyId")).toEqual({
    kind: "API key",
  });
  for (const value of [deleteOrgKey, revokeTheirs]) {
    expect(await read(workspaceAdmin, value, "apiKeyId")).toBeUndefined();
  }
  expect(await read(workspaceAdmin, deleteHook, "webhookId")).toBeUndefined();
  // An organization admin who isn't an owner can't list these through the API either.
  for (const value of [deleteOrgKey, revokeTheirs]) {
    expect(await read(organizationAdmin, value, "apiKeyId")).toBeUndefined();
  }
  expect(await read(organizationAdmin, deleteHook, "webhookId")).toBeUndefined();
  // Another organization's id is unresolved, not "not found".
  expect(
    await read(
      admin,
      {
        ...deleteOrgKey,
        pathParameters: { organizationId: crypto.randomUUID(), apiKeyId: orgKey },
      },
      "apiKeyId",
    ),
  ).toBeUndefined();
  // Even with an id that isn't one: the organization is checked first.
  for (const [value, parameter] of [
    [deleteOrgKey, "apiKeyId"],
    [deleteHook, "webhookId"],
  ] as const) {
    expect(
      await read(
        admin,
        { ...value, pathParameters: { organizationId: crypto.randomUUID(), [parameter]: "nope" } },
        parameter,
      ),
    ).toBeUndefined();
  }
  // An admin sees what the API shows them.
  expect(await read(admin, deleteOrgKey, "apiKeyId")).toMatchObject({ name: "CI deploy key" });
  expect(await read(admin, revokeTheirs, "apiKeyId")).toMatchObject({ name: "Their laptop" });
  const webhook = await read(admin, deleteHook, "webhookId");
  expect(webhook).toEqual({ kind: "webhook", name: "hooks.slack.com", facts: [] });
  expect(JSON.stringify(webhook)).not.toContain("s3cret");
});

test("routes whose ids belong to something else get no lookup", async () => {
  const { appActionTargetLookupKey } = await import("../src/app-action-targets");
  expect(
    appActionTargetLookupKey(
      "/v1/workspaces/:workspaceId/sessions/:sessionId/realtime/:realtimeId/connections/:connectionId/activate",
      "connectionId",
    ),
  ).toBeUndefined();
  expect(
    appActionTargetLookupKey(
      "/v1/workspaces/external/:workspaceSource/:workspaceExternalId/members/:subjectId/allowance",
      "subjectId",
    ),
  ).toBeUndefined();
  expect(
    appActionTargetLookupKey("/v1/workspaces/:workspaceId/vaults/:vaultId/items/:itemId", "itemId"),
  ).toBe("items/:itemId");
  // Browser and computer sessions read through their source chat's
  // visibility, private-task summaries through an organization setting, and
  // Skills from their facets: no lookup approximates those.
  for (const [path, parameter] of [
    ["/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId", "browserSessionId"],
    ["/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/end", "computerSessionId"],
    ["/v1/workspaces/:workspaceId/scheduled-tasks/private-summaries/:taskId/pause", "taskId"],
    ["/v1/workspaces/:workspaceId/skills/:capabilityId", "capabilityId"],
  ] as const) {
    expect(appActionTargetLookupKey(path, parameter)).toBeUndefined();
  }
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
  // An owner, who may read every target an action can name, read live.
  const person = await member(org.accountId, org.workspaceId, "owner", ["workspace:admin"]);
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
        workspaceId: org.workspaceId,
        subjectId: person,
        onLookupError: (error, name) =>
          failures.push(
            `${entry.id} ${name}: ${String((error as { cause?: Error }).cause?.message ?? (error as Error).message).slice(0, 200)}`,
          ),
      },
      { id: entry.id, pathParameters },
    );
    for (const name of names) {
      if (!appActionTargetLookupKey(entry.path, name) || name === "workspaceId") continue;
      // Integrations can be defined in code, so one missing from the catalog stays unresolved.
      if (name === "capabilityId") continue;
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

test("a member never sees a colleague's private rows or the workspace's keys and webhooks", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  // Both may use automations and chats, so only the rows' privacy tells them apart.
  const automations = ["workspace:read", "scheduled_tasks:run", "sessions:read"];
  const person = await member(org.accountId, org.workspaceId, "member", automations);
  const colleague = await member(org.accountId, org.workspaceId, "member", automations);
  const workspaceAdmin = await member(org.accountId, org.workspaceId, "member", [
    "workspace:admin",
  ]);
  // An "admin" role label without the permissions: the API reads permissions.
  const labelOnly = await member(
    org.accountId,
    org.workspaceId,
    "member",
    ["workspace:read"],
    "admin",
  );
  const [source] = await shared!.admin<{ id: string }[]>`
    insert into event_sources (account_id, workspace_id, kind, name, visibility,
      owner_subject_id, created_by_subject_id)
    values (${org.accountId}, ${org.workspaceId}, 'workspace', 'Colleague private source',
      'private', ${colleague}, ${colleague})
    returning id`;
  const [template] = await shared!.admin<{ id: string }[]>`
    insert into bot_templates (account_id, workspace_id, name, setup_instructions, visibility,
      created_by_subject_id)
    values (${org.accountId}, ${org.workspaceId}, 'Colleague private template', 'x', 'private',
      ${colleague})
    returning id`;
  const [key] = await shared!.admin<{ id: string }[]>`
    insert into api_keys (account_id, workspace_id, name, prefix, key_hash, credential_kind)
    values (${org.accountId}, ${org.workspaceId}, 'Prod deploy key', 'og_zz12',
      ${crypto.randomUUID()}, 'workspace')
    returning id`;
  const [hook] = await shared!.admin<{ id: string }[]>`
    insert into workspace_webhooks (account_id, workspace_id, url, secret_encrypted, event_types)
    values (${org.accountId}, ${org.workspaceId}, 'https://ops.example.com/hook', 'sealed',
      ${["turn.completed"]})
    returning id`;
  const calls = [
    ["deleteEventSource", "sourceId", source!.id],
    ["deleteBotTemplate", "templateId", template!.id],
    ["deleteApiKey", "apiKeyId", key!.id],
    ["deleteWorkspaceWebhook", "webhookId", hook!.id],
  ] as const;
  const read = async (subjectId: string, [id, parameter, value]: (typeof calls)[number]) =>
    (
      await resolveAppActionTargets(
        client!.db,
        { accountId: org.accountId, workspaceId: org.workspaceId, subjectId },
        { id, pathParameters: { workspaceId: org.workspaceId, [parameter]: value } },
      )
    )[parameter];
  for (const reader of [person, labelOnly]) {
    for (const call of reader === person ? calls : calls.slice(2)) {
      const target = await read(reader, call);
      expect(target?.name).toBeUndefined();
      expect(JSON.stringify(target ?? {})).not.toMatch(/Colleague|Prod deploy|ops\.example/u);
    }
  }
  // Their owner sees the private ones; a workspace admin manages keys and webhooks.
  expect((await read(colleague, calls[0]))?.name).toBe("Colleague private source");
  expect((await read(colleague, calls[1]))?.name).toBe("Colleague private template");
  expect((await read(workspaceAdmin, calls[2]))?.name).toBe("Prod deploy key");
  expect((await read(workspaceAdmin, calls[3]))?.name).toBe("ops.example.com");
});

test("a resumed attempt reads the wording its approval was first saved with", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  // A fully set up workspace, so a chat can be created in it.
  const workspace = await createWorkspace(client.db, { accountId: org.accountId, name: "Ops" });
  const ids = {
    workspaceId: workspace.id,
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
  };
  // Only the saved request matters here, not the turn and attempt it belongs to.
  await shared!.admin.begin(async (tx) => {
    await tx`
      insert into sessions(id, account_id, workspace_id, initial_message, model,
        reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
        root_session_id, status, created_by_kind, created_by_subject_id)
      values (${ids.sessionId}, ${org.accountId}, ${ids.workspaceId}, 'Remove connections',
        'test-model', 'medium', 'standard', 'none', ${ids.sessionId},
        ${tx.json({ mode: "explicit", inheritedFromSessionId: null })}, ${ids.sessionId},
        'idle', 'subject', 'user:bendik')`;
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into connector_action_requests
        (account_id, workspace_id, session_id, turn_id, creation_attempt_id,
         creation_execution_generation, approval_id, initiator_kind, initiator_subject_id,
         connection_id, server_id, tool_name, action_name, policy_source, policy_decision,
         action_fingerprint, review_context, status)
      values (${org.accountId}, ${ids.workspaceId}, ${ids.sessionId}, ${ids.turnId},
        ${crypto.randomUUID()}, 1, 'call-1', 'subject', 'user:bendik',
        'session-mcp:opengeni:hash', 'opengeni', 'admin_action_call', 'admin_action_call',
        'default', 'ask', ${"f".repeat(64)},
        ${tx.json({
          kind: "generic",
          title: "Remove the Gmail connection for bendik@cloudgeni.ai?",
          targetFacts: [{ label: "Added", value: "14 Oct 2026, 07:41 UTC" }],
        })},
        'pending')`;
  });
  const scope = { accountId: org.accountId, ...ids };
  expect(await savedAppActionApprovalCard(client.db, { ...scope, approvalId: "call-1" })).toEqual({
    title: "Remove the Gmail connection for bendik@cloudgeni.ai?",
    targetFacts: [{ label: "Added", value: "14 Oct 2026, 07:41 UTC" }],
  });
  expect(
    await savedAppActionApprovalCard(client.db, { ...scope, approvalId: "call-2" }),
  ).toBeUndefined();
  // Another tool's saved request with an app action's approval id is never its card.
  await shared!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into connector_action_requests
        (account_id, workspace_id, session_id, turn_id, creation_attempt_id,
         creation_execution_generation, approval_id, initiator_kind, initiator_subject_id,
         connection_id, server_id, tool_name, action_name, policy_source, policy_decision,
         action_fingerprint, review_context, status)
      values (${org.accountId}, ${ids.workspaceId}, ${ids.sessionId}, ${ids.turnId},
        ${crypto.randomUUID()}, 1, 'call-3', 'subject', 'user:bendik',
        'session-mcp:gmail:hash', 'gmail', 'send_email', 'send_email',
        'default', 'ask', ${"e".repeat(64)},
        ${tx.json({ kind: "generic", title: "Approve everything?" })}, 'pending')`;
  });
  expect(
    await savedAppActionApprovalCard(client.db, { ...scope, approvalId: "call-3" }),
  ).toBeUndefined();
  // Another turn's request is another question.
  expect(
    await savedAppActionApprovalCard(client.db, {
      ...scope,
      turnId: crypto.randomUUID(),
      approvalId: "call-1",
    }),
  ).toBeUndefined();
});

test("an organization owner sees nothing inside a workspace they aren't a member of", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const secret = await org.workspace("Secret team");
  const owner = await member(org.accountId, org.workspaceId, "owner");
  const [key] = await shared!.admin<{ id: string }[]>`
    insert into api_keys (account_id, workspace_id, name, prefix, key_hash, credential_kind)
    values (${org.accountId}, ${secret}, 'Secret key', 'og_ss12', ${crypto.randomUUID()},
      'workspace')
    returning id`;
  const [hook] = await shared!.admin<{ id: string }[]>`
    insert into workspace_webhooks (account_id, workspace_id, url, secret_encrypted, event_types)
    values (${org.accountId}, ${secret}, 'https://secret.example.com/hook', 'sealed',
      ${["turn.completed"]})
    returning id`;
  const gmail = await connection({
    accountId: org.accountId,
    workspaceId: secret,
    providerDomain: "gmail.example",
    metadata: { email: "secret@cloudgeni.ai" },
  });
  const scope = { accountId: org.accountId, workspaceId: org.workspaceId, subjectId: owner };
  for (const [id, parameter, value] of [
    ["deleteApiKey", "apiKeyId", key!.id],
    ["deleteWorkspaceWebhook", "webhookId", hook!.id],
    ["deleteConnection", "connectionId", gmail],
  ] as const) {
    const targets = await resolveAppActionTargets(client.db, scope, {
      id,
      pathParameters: { workspaceId: secret, [parameter]: value },
    });
    expect(targets).toEqual({});
  }
});

test("rigs are read through the rig routes' own scope and status", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const marketing = await org.workspace("Marketing");
  const riggers = ["workspace:read", "rigs:use"];
  const person = await member(org.accountId, org.workspaceId, "member", riggers);
  const colleague = await member(org.accountId, org.workspaceId, "member", riggers);
  const rig = async (input: { name: string } & Partial<Parameters<typeof createRig>[1]>) =>
    (
      await createRig(client!.db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        ...input,
      })
    ).id;
  const team = await rig({ name: "Team rig" });
  const theirs = await rig({ name: "Bob's secret rig", scope: "user", subjectId: colleague });
  const organizationRig = await rig({
    name: "Org rig",
    workspaceId: marketing,
    scope: "organization",
    allowOrganization: true,
  });
  const old = await rig({ name: "Old rig" });
  await shared!.admin`update rigs set status = 'revoked', revoked_at = now() where id = ${old}`;
  const named = async (rigId: string, subjectId = person) =>
    (
      await resolveAppActionTargets(
        client!.db,
        { accountId: org.accountId, workspaceId: org.workspaceId, subjectId },
        { id: "deleteRig", pathParameters: { workspaceId: org.workspaceId, rigId } },
      )
    ).rigId;
  expect((await named(team))?.name).toBe("Team rig");
  // The organization's rig, made in another workspace, as the rig routes show it.
  expect((await named(organizationRig))?.name).toBe("Org rig");
  // A colleague's own rig and a revoked one are gone from the routes.
  expect((await named(theirs))?.name).toBeUndefined();
  expect((await named(old))?.name).toBeUndefined();
  expect((await named(theirs, colleague))?.name).toBe("Bob's secret rig");
  // Without rigs:use, none is named, nor called not found.
  expect(await named(team, await member(org.accountId, org.workspaceId))).toBeUndefined();
});

test("each route's own permission, and no membership counts only in a Personal workspace", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const reader = await member(org.accountId, org.workspaceId);
  const chatter = await member(org.accountId, org.workspaceId, "member", [
    "workspace:read",
    "sessions:read",
  ]);
  const owner = await member(org.accountId, org.workspaceId, "owner");
  const scope = (subjectId: string, workspaceId = org.workspaceId) => ({
    accountId: org.accountId,
    workspaceId,
    subjectId,
  });
  const id = crypto.randomUUID();
  // Channels and bot templates are read with sessions:read.
  for (const [action, parameter] of [
    ["deleteChannel", "channelId"],
    ["deleteBotTemplate", "templateId"],
  ] as const) {
    const call = { id: action, pathParameters: { workspaceId: org.workspaceId, [parameter]: id } };
    expect((await resolveAppActionTargets(client.db, scope(reader), call))[parameter]).toBe(
      undefined,
    );
    expect(
      (await resolveAppActionTargets(client.db, scope(chatter), call))[parameter],
    ).toMatchObject({ kind: expect.any(String) });
  }
  // The organization's subscription accounts are an owner's or admin's.
  const subscription = {
    id: "DELETE /v1/organizations/:organizationId/codex/accounts/:accountId",
    pathParameters: { organizationId: org.accountId, accountId: id },
  };
  expect(
    (await resolveAppActionTargets(client.db, scope(reader), subscription)).accountId,
  ).toBeUndefined();
  expect((await resolveAppActionTargets(client.db, scope(owner), subscription)).accountId).toEqual({
    kind: "account",
  });
  // Without a membership row, only the person's own Personal workspace counts.
  const [{ personal_workspace_id: personal } = { personal_workspace_id: "" }] = await shared!.admin<
    { personal_workspace_id: string }[]
  >`
    select personal_workspace_id from organization_memberships
    where account_id = ${org.accountId} and subject_id = ${reader}`;
  expect(
    (await resolveAppActionTargets(client.db, scope(reader, personal), removal(personal, id)))
      .connectionId,
  ).toEqual({ kind: "connection" });
  // An owner whose chat runs in a workspace they aren't a member of reads nothing in it.
  const team = await org.workspace("Team");
  expect(await resolveAppActionTargets(client.db, scope(owner, team), removal(team, id))).toEqual(
    {},
  );
});

test("a chat started in someone else's private Slack thread is never named", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const workspace = await createWorkspace(client.db, { accountId: org.accountId, name: "Ops" });
  const person = await member(org.accountId, workspace.id, "member", [
    "workspace:read",
    "sessions:read",
  ]);
  const colleague = `user:${crypto.randomUUID()}`;
  const chat = async (title: string, slackOwner?: string) => {
    const id = crypto.randomUUID();
    await shared!.admin.begin(async (tx) => {
      await tx`
        insert into sessions(id, account_id, workspace_id, title, initial_message, model,
          reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
          root_session_id, status, created_by_kind, created_by_subject_id)
        values (${id}, ${org.accountId}, ${workspace.id}, ${title}, 'Hi', 'test-model',
          'medium', 'standard', 'none', ${id},
          ${tx.json({ mode: "explicit", inheritedFromSessionId: null })}, ${id},
          'idle', 'subject', ${slackOwner ?? person})`;
      // A title the person gave it, which the automatic-title guard keeps.
      await tx`update sessions set title = ${title}, title_source = 'user' where id = ${id}`;
      if (!slackOwner) return;
      // Only the interaction's privacy matters here, not its Slack connection.
      await tx`set local session_replication_role = replica`;
      await tx`
        insert into slack_interactions (account_id, workspace_id, connection_id, slack_team_id,
          slack_channel_id, slack_thread_ts, route_key, triggering_provider_event_id,
          owning_subject_id, visibility, session_reservation_id, session_id)
        values (${org.accountId}, ${workspace.id}, ${crypto.randomUUID()}, 'T1', 'D1', '1.0',
          ${`route-${id}`}, ${`event-${id}`}, ${slackOwner}, 'private', ${id}, ${id})`;
    });
    return id;
  };
  const named = async (sessionId: string) =>
    (
      await resolveAppActionTargets(
        client!.db,
        { accountId: org.accountId, workspaceId: workspace.id, subjectId: person },
        { id: "deleteSession", pathParameters: { workspaceId: workspace.id, sessionId } },
      )
    ).sessionId;
  expect((await named(await chat("Release plan")))?.name).toBe("Release plan");
  const theirs = await named(await chat("Colleague's DM with the bot", colleague));
  expect(theirs).toEqual({ kind: "chat" });
});

test("documents follow the document routes' authority, wherever they were added", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const marketing = await org.workspace("Marketing");
  const readers = ["workspace:read", "documents:search"];
  const person = await member(org.accountId, org.workspaceId, "member", readers);
  const colleague = await member(org.accountId, org.workspaceId, "member", readers);
  const baseId = crypto.randomUUID();
  const document = async (
    title: string,
    authority: { kind: string; workspaceId?: string; subjectId?: string },
    workspaceId = org.workspaceId,
  ) =>
    await shared!.admin.begin(async (tx) => {
      const [file] = await tx<{ id: string }[]>`
        insert into files (account_id, workspace_id, status, filename, safe_filename,
          content_type, size_bytes, bucket, object_key)
        values (${org.accountId}, ${workspaceId}, 'ready', 'notes.txt', 'notes.txt',
          'text/plain', 1, 'test', ${`documents/${crypto.randomUUID()}`})
        returning id`;
      // Only the document's authority matters here, not its collection.
      await tx`set local session_replication_role = replica`;
      const [row] = await tx<{ id: string }[]>`
        insert into documents (account_id, workspace_id, origin_workspace_id, base_id, file_id,
          title, authority_kind, authority_workspace_id, authority_subject_id, visibility,
          created_by)
        values (${org.accountId}, ${workspaceId}, ${workspaceId}, ${baseId}, ${file!.id},
          ${title}, ${authority.kind}, ${authority.workspaceId ?? null},
          ${authority.subjectId ?? null}, ${authority.kind === "personal" ? "private" : "workspace"},
          ${authority.subjectId ?? null})
        returning id`;
      return row!.id;
    });
  const handbook = await document("Handbook", { kind: "organization" }, marketing);
  const mine = await document("My notes", { kind: "personal", subjectId: person });
  const theirs = await document("Colleague notes", { kind: "personal", subjectId: colleague });
  const elsewhere = await document(
    "Marketing plan",
    { kind: "workspace", workspaceId: marketing },
    marketing,
  );
  const named = async (documentId: string) =>
    (
      await resolveAppActionTargets(
        client!.db,
        { accountId: org.accountId, workspaceId: org.workspaceId, subjectId: person },
        {
          id: "deleteDocument",
          pathParameters: { workspaceId: org.workspaceId, baseId, documentId },
        },
      )
    ).documentId;
  // The organization's document reads from every workspace, as the routes read it.
  expect((await named(handbook))?.name).toBe("Handbook");
  expect((await named(mine))?.name).toBe("My notes");
  expect((await named(theirs))?.name).toBeUndefined();
  expect((await named(elsewhere))?.name).toBeUndefined();
});

test("an integration missing from the catalog stays unresolved, and a suspended member sees nothing", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const person = await member(org.accountId, org.workspaceId, "member", [
    "workspace:read",
    "connections:read",
  ]);
  const scope = { accountId: org.accountId, workspaceId: org.workspaceId, subjectId: person };
  // Defined in code or a plugin's manifest, not the catalog: never "not found".
  const uninstall = await resolveAppActionTargets(client.db, scope, {
    id: "uninstallApiIntegration",
    pathParameters: { workspaceId: org.workspaceId, capabilityId: "api:fiken", instanceKey: "x" },
  });
  expect(uninstall).not.toHaveProperty("capabilityId");
  expect(
    await resolveAppActionTargets(client.db, scope, {
      id: "uninstallSkill",
      pathParameters: { workspaceId: org.workspaceId, capabilityId: "skill:pdf" },
    }),
  ).toEqual({});
  // A shared connection, named while they're active and not once they're suspended.
  const gmail = await connection({
    ...org,
    providerDomain: "gmail.example",
    metadata: { email: "team@cloudgeni.ai" },
  });
  expect(
    (await resolveAppActionTargets(client.db, scope, removal(org.workspaceId, gmail))).connectionId,
  ).toMatchObject({ name: "gmail.example" });
  await shared!.admin`
    update organization_memberships set status = 'suspended'
    where account_id = ${org.accountId} and subject_id = ${person}`;
  expect(await resolveAppActionTargets(client.db, scope, removal(org.workspaceId, gmail))).toEqual(
    {},
  );
});

test("ids are read as their routes read them; the organization's custom models as the person", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const owner = await member(org.accountId, org.workspaceId, "owner", ["workspace:admin"]);
  const scope = { accountId: org.accountId, workspaceId: org.workspaceId, subjectId: owner };
  // The route reads an installation id as a number: "0042" is installation 42.
  await shared!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into github_installations (account_id, workspace_id, installation_id, account_login,
        account_type)
      values (${org.accountId}, ${org.workspaceId}, 42, 'acme', 'Organization')`;
  });
  const unlink = (installationId: string) => ({
    id: "unlinkGitHubInstallation",
    pathParameters: { workspaceId: org.workspaceId, installationId },
  });
  for (const id of ["42", "0042"]) {
    expect(
      (await resolveAppActionTargets(client.db, scope, unlink(id))).installationId,
    ).toMatchObject({ name: "acme" });
  }
  // An id the route decodes again, or one padded with spaces, may be another
  // record than it reads as: it's left unread, never "not found".
  for (const subjectId of [encodeURIComponent(owner), ` ${owner}`]) {
    expect(
      await resolveAppActionTargets(client.db, scope, {
        id: "removeWorkspaceMember",
        pathParameters: { workspaceId: org.workspaceId, subjectId },
      }),
    ).toEqual({});
  }
  // The organization's custom models, for the route's provider only.
  const [model] = await shared!.admin<{ id: string }[]>`
    insert into organization_model_provider_custom_models (account_id, provider_kind,
      upstream_model_id, label, create_operation_id, create_request_hash, created_by_subject_id)
    values (${org.accountId}, 'opper', 'gpt-x', 'Team model', ${crypto.randomUUID()},
      ${"a".repeat(64)}, ${owner})
    returning id`;
  const remove = (providerKind: string) => ({
    id: "deleteOrganizationProviderCustomModel",
    pathParameters: { organizationId: org.accountId, providerKind, customModelId: model!.id },
  });
  expect((await resolveAppActionTargets(client.db, scope, remove("opper"))).customModelId).toEqual({
    kind: "custom model",
    name: "Team model",
    facts: [{ label: "Model", value: "gpt-x" }],
  });
  expect(
    (await resolveAppActionTargets(client.db, scope, remove("openrouter"))).customModelId,
  ).toEqual({ kind: "custom model" });
});
