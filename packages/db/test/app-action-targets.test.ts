import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import { createDb, createWorkspace, type DbClient } from "../src";
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

/** A member of the organization and of the workspace, with their roles in each. */
async function member(
  accountId: string,
  workspaceId: string,
  role = "member",
  workspaceRole = "member",
) {
  const subjectId = `user:${crypto.randomUUID()}`;
  const [personal] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, 'Personal') returning id`;
  await shared!.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}, ${subjectId}, ${role}, 'active', ${personal!.id})`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}, ${workspaceId}, ${subjectId}, ${workspaceRole})`;
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
    insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role)
    values (${org.accountId}, ${marketing}, ${subjectId}, 'jorgen@cloudgeni.ai', 'admin')`;
  const call = {
    id: "removeWorkspaceMember",
    pathParameters: { workspaceId: marketing, subjectId },
  };
  // A member of Staging only: Marketing's name and members stay unresolved.
  const outsider = await member(org.accountId, org.workspaceId);
  const scope = { accountId: org.accountId, workspaceId: org.workspaceId, subjectId: outsider };
  expect(await resolveAppActionTargets(client.db, scope, call)).toEqual({});
  // A workspace admin of Staging is still an outsider to Marketing.
  const stagingAdmin = await member(org.accountId, org.workspaceId, "member", "admin");
  expect(
    await resolveAppActionTargets(client.db, { ...scope, subjectId: stagingAdmin }, call),
  ).toEqual({});
  // An organization admin, or a member of Marketing, sees it as the API does.
  const organizationAdmin = await member(org.accountId, org.workspaceId, "admin");
  for (const reader of [
    { ...scope, subjectId: organizationAdmin },
    { ...scope, subjectId: subjectId },
  ]) {
    const targets = await resolveAppActionTargets(client.db, reader, call);
    expect(targets.workspaceId).toEqual({ kind: "workspace", name: "Marketing" });
    expect(targets.subjectId).toMatchObject({
      kind: "member",
      name: "jorgen@cloudgeni.ai",
      facts: [{ label: "Role", value: "Admin" }, { label: "Member since" }],
    });
  }
  // Without a person nothing is read at all.
  expect(await resolveAppActionTargets(client.db, { ...scope, subjectId: null }, call)).toEqual({});
});

test("a colleague's Only me Site or schedule is never named; shared ones and your own are", async () => {
  if (!client) return;
  const org = await organization("Cloudgeni");
  const person = await member(org.accountId, org.workspaceId);
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
});

test("organization records and other people's keys need an admin; webhooks show only their host", async () => {
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
  const admin = { ...member_, subjectId: await member(org.accountId, org.workspaceId, "admin") };
  // A workspace admin whose organization role is member: the turn's frozen
  // grant can imply account:admin for them, but the API's routes don't.
  const workspaceAdmin = {
    ...member_,
    subjectId: await member(org.accountId, org.workspaceId, "member", "admin"),
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
  for (const value of [deleteOrgKey, revokeTheirs]) {
    expect(await read(workspaceAdmin, value, "apiKeyId")).toBeUndefined();
  }
  expect(await read(workspaceAdmin, deleteHook, "webhookId")).toBeUndefined();
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
  const person = await member(org.accountId, org.workspaceId);
  const colleague = await member(org.accountId, org.workspaceId);
  const workspaceAdmin = await member(org.accountId, org.workspaceId, "member", "admin");
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
  for (const call of calls) {
    const target = await read(person, call);
    expect(target?.name).toBeUndefined();
    expect(JSON.stringify(target ?? {})).not.toMatch(/Colleague|Prod deploy|ops\.example/u);
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
  // Another turn's request is another question.
  expect(
    await savedAppActionApprovalCard(client.db, {
      ...scope,
      turnId: crypto.randomUUID(),
      approvalId: "call-1",
    }),
  ).toBeUndefined();
});
