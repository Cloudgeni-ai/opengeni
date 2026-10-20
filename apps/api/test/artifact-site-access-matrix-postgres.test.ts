import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { SITE_GATEWAY_CALLBACK_PATH } from "@opengeni/contracts";
import type { ObjectStorageDependency, SessionWorkflowClient } from "@opengeni/core";
import {
  acceptOrganizationInvitation,
  claimSessionWorkForAttempt,
  createDb,
  createOrganizationInvitation,
  createSession,
  ensureManagedAccessForUserWithOrganizationMemberships,
  freezeAgentLearningPolicy,
  nestedPostgresSqlState,
  upsertWorkspaceMemberAsWorkspaceManager,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import type { Settings } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp, type AppDependencies } from "../src/app";
import { PostgresEditableArtifactAuthorization } from "../src/editable-artifact-production";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { signSiteGatewayRequest } from "../src/site-publishing/gateway-signature";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccessGrant } from "@opengeni/contracts";

/*
 * The artifact and Site access matrix, end to end through the real app and
 * PostgreSQL as the restricted application role: personal and shared
 * workspaces; the owner, a workspace admin, a Member, a Viewer, a signed-in
 * person outside the workspace and an anyone-with-the-link guest; create,
 * new version, rollback, audience, publish, view, Site Data and Site AI.
 *
 * People sign in with a verified managed cookie, exactly as in the product:
 * a personal workspace has no workspace_memberships row, its owner's
 * authority is the organization membership's personal workspace pointer.
 */

let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("artifact-site-access-matrix");
  if (!acquired) throw new Error("The artifact and Site access matrix requires real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

const ORIGIN = "http://opengeni.test";
const DOMAIN = "sites.example.test";
const SECRET = "m".repeat(40);
const noop = async () => undefined;

function memoryObjectStorage(): ObjectStorageDependency {
  const objects = new Map<string, Uint8Array>();
  return {
    maxSinglePutSizeBytes: 5_000_000_000,
    headObject: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { ContentLength: bytes.length, VersionToken: "v" } : null;
    },
    getObjectRange: async (input: { key: string; start: number; endInclusive: number }) => {
      const bytes = objects.get(input.key);
      return bytes
        ? { bytes: bytes.slice(input.start, input.endInclusive + 1), versionToken: "v" }
        : null;
    },
    putObject: async (input: { key: string; body: Uint8Array }) => {
      objects.set(input.key, input.body.slice());
    },
    putObjectStreamIfAbsent: async (input: { key: string; chunks: AsyncIterable<Uint8Array> }) => {
      if (objects.has(input.key)) return false;
      const parts: Uint8Array[] = [];
      for await (const part of input.chunks) parts.push(part);
      objects.set(input.key, Buffer.concat(parts));
      return true;
    },
    getObjectBytes: async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { bytes, contentType: "text/html" } : null;
    },
    createGetUrl: async (input: { key: string }) => ({
      url: `https://storage.example.test/${input.key}`,
      expiresAt: new Date(Date.now() + 60_000),
    }),
    createPutUrl: async (input: { key: string }) => ({
      url: `https://storage.example.test/${input.key}`,
      expiresAt: new Date(Date.now() + 60_000),
      requiredHeaders: {},
    }),
    deleteObject: async (key: string) => {
      objects.delete(key);
    },
  } as unknown as ObjectStorageDependency;
}

type Result = { status: number; json: any };
async function read(response: Response): Promise<Result> {
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, json: text };
  }
}
const errorCode = (result: Result) =>
  result.json?.error?.details?.code ?? result.json?.error?.code ?? null;

type Person = { userId: string; subjectId: string; email: string; cookie: string };
const cookies = new Map<string, { authSessionId: string; userId: string; email: string }>();

function buildApp(overrides: Partial<Settings> = {}) {
  const settings = testSettings({
    productAccessMode: "managed",
    publicBaseUrl: ORIGIN,
    sandboxBackend: "none",
    delegationSecret: randomBytes(32).toString("hex"),
    sitesDomain: DOMAIN,
    sitesGatewaySecret: SECRET,
    sessionUsageLimitsEnabled: true,
    ...overrides,
  });
  const deps = {
    db: client.db,
    bus: new MemoryEventBus(),
    settings,
    objectStorage: memoryObjectStorage(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const record = cookies.get(headers.get("cookie") ?? "");
          if (!record) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: record.authSessionId },
              user: {
                id: record.userId,
                email: record.email,
                emailVerified: true,
                name: "Matrix person",
              },
            },
          };
        },
      },
    },
  } as unknown as AppDependencies;
  return { app: createApp(deps), deps, settings };
}

/** One verified Better Auth login; `ownOrganization` bootstraps their own organization. */
async function signUp(ownOrganization: boolean): Promise<Person> {
  const userId = `matrix-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  await shared.admin`insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Matrix person', ${email}, true)`;
  await shared.admin`insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  if (ownOrganization)
    await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email,
      name: "Matrix person",
      emailVerified: true,
    });
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  const cookie = `session=${authSessionId}`;
  cookies.set(cookie, { authSessionId, userId, email });
  return { userId, subjectId: `user:${userId}`, email, cookie };
}

async function organizationOf(person: Person) {
  const [membership] = await shared.admin<
    Array<{ accountId: string; personalWorkspaceId: string }>
  >`select account_id as "accountId", personal_workspace_id as "personalWorkspaceId"
    from organization_memberships where subject_id = ${person.subjectId} and status = 'active'`;
  if (!membership) throw new Error("No organization membership");
  return membership;
}

async function invite(owner: Person, accountId: string): Promise<Person> {
  const person = await signUp(false);
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: person.subjectId,
    targetEmail: person.email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: person.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  return person;
}

async function presetPermissions(role: "admin" | "member" | "viewer") {
  const [row] = await shared.admin<Array<{ permissions: string[] }>>`
    select opengeni_private.workspace_member_role_permissions(${role}) as permissions`;
  return row!.permissions;
}

type Cell = {
  workspace: "personal" | "shared";
  actor: string;
  action: string;
  expected: string;
  actual: string;
};

async function matrixFixture() {
  const { app, deps, settings } = buildApp();
  const owner = await signUp(true);
  const organization = await organizationOf(owner);
  const accountId = organization.accountId;
  const personalWorkspaceId = organization.personalWorkspaceId;
  const browser = (person: Person) => ({
    cookie: person.cookie,
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  });
  const api = async (person: Person, method: string, path: string, body?: unknown) =>
    await read(
      await app.request(path, {
        method,
        headers: browser(person),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  // A shared workspace made from the console: its creator owns it.
  const created = await api(owner, "POST", "/v1/workspaces", { accountId, name: "Team" });
  if (created.status !== 201) throw new Error(`workspace create ${created.status}`);
  const sharedWorkspace = { id: String(created.json.id) };
  const people: Record<"admin" | "member" | "viewer", Person> = {
    admin: await invite(owner, accountId),
    member: await invite(owner, accountId),
    viewer: await invite(owner, accountId),
  };
  for (const role of ["admin", "member", "viewer"] as const)
    await upsertWorkspaceMemberAsWorkspaceManager(client.db, {
      accountId,
      workspaceId: sharedWorkspace.id,
      actorSubjectId: owner.subjectId,
      targetSubjectId: people[role].subjectId,
      mode: "add",
      role,
      permissions: (await presetPermissions(role)) as never,
    });
  // Someone signed in to Opengeni in another organization.
  const outsider = await signUp(true);

  const gateway = async (
    host: string,
    method: string,
    path: string,
    options: { body?: unknown; session?: string; visitor?: string } = {},
  ) => {
    const pathWithQuery = `/v1/site-runtime${path}`;
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    const signed = signSiteGatewayRequest({
      secret: SECRET,
      method,
      pathWithQuery,
      host,
      body,
      ...(options.session ? { session: options.session } : {}),
      ...(options.visitor ? { visitor: options.visitor } : {}),
      clientIp: "198.51.100.9",
    });
    return await read(
      await app.request(pathWithQuery, {
        method,
        headers: { ...signed, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body } : {}),
      }),
    );
  };
  /** Viewer sign-in on a Site host: authorize as the person, exchange as the gateway. */
  const signIn = async (person: Person, host: string): Promise<Result & { token?: string }> => {
    const verifier = randomBytes(32).toString("base64url");
    const authorized = await api(person, "POST", "/v1/site-auth/authorize", {
      host,
      state: randomBytes(16).toString("base64url"),
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      redirectUri: `https://${host}${SITE_GATEWAY_CALLBACK_PATH}`,
    });
    if (authorized.status !== 200) return authorized;
    const authCode = new URL(authorized.json.redirectTo).searchParams.get("code") ?? "";
    const exchanged = await gateway(host, "POST", "/auth/exchange", {
      body: {
        code: authCode,
        codeVerifier: verifier,
        redirectUri: `https://${host}${SITE_GATEWAY_CALLBACK_PATH}`,
      },
    });
    return { ...exchanged, token: exchanged.json?.sessionToken };
  };
  return {
    app,
    deps,
    settings,
    accountId,
    owner,
    outsider,
    people,
    workspaces: { personal: personalWorkspaceId, shared: sharedWorkspace.id },
    api,
    gateway,
    signIn,
  };
}

type Fixture = Awaited<ReturnType<typeof matrixFixture>>;
type Viewer = { session?: string; visitor?: string };
const visitorId = () => randomBytes(18).toString("base64url");
const brief = (result: Result) => {
  const code = errorCode(result);
  return code ? `${result.status} ${code}` : String(result.status);
};
const html = (title: string) => `<!doctype html><title>${title}</title><h1>${title}</h1>`;

function matrix(f: Fixture) {
  const cells: Cell[] = [];
  const record = (
    workspace: Cell["workspace"],
    actor: string,
    action: string,
    expected: string,
    actual: string,
  ) => {
    cells.push({ workspace, actor, action, expected, actual });
  };
  const sites = (workspace: Cell["workspace"]) =>
    `/v1/workspaces/${f.workspaces[workspace]}/published-artifacts`;
  const createSite = async (
    who: Person,
    workspace: Cell["workspace"],
    title: string,
    visibility?: "private" | "workspace",
  ) =>
    await f.api(who, "POST", sites(workspace), {
      title,
      html: html(title),
      idempotencyKey: crypto.randomUUID(),
      ...(visibility ? { visibility } : {}),
    });
  const publish = (
    who: Person,
    workspace: Cell["workspace"],
    siteId: string,
    body: Record<string, unknown>,
  ) => f.api(who, "PUT", `${sites(workspace)}/${siteId}/publication`, body);
  const viewerFor = async (who: Person | "guest", host: string): Promise<Viewer | Result> => {
    if (who === "guest") return { visitor: visitorId() };
    const signed = await f.signIn(who, host);
    return signed.token ? { session: signed.token } : signed;
  };
  const isViewer = (value: Viewer | Result): value is Viewer => !("status" in value);
  /** Open the published Site: the viewer kind it sees, or the refusal. */
  const open = async (host: string, viewer: Viewer) => {
    const config = await f.gateway(host, "GET", "/site/config", viewer);
    return config.status === 200 ? `200 ${config.json.viewer?.kind}` : brief(config);
  };
  /** Whether the page is told the Site's assistant is available to this viewer. */
  const assistantOffered = async (host: string, viewer: Viewer) => {
    const config = await f.gateway(host, "GET", "/site/config", viewer);
    if (config.status !== 200) return brief(config);
    return config.json.capabilities?.agent === true ? "offered" : "not offered";
  };
  /** The model ids the Site offers this viewer, sorted. */
  const siteModels = async (host: string, viewer: Viewer) => {
    const listed = await f.gateway(host, "GET", "/model-catalog", viewer);
    if (listed.status !== 200) return brief(listed);
    return ((listed.json?.models ?? []) as Array<{ id: string }>)
      .map((model) => model.id)
      .sort()
      .join(",");
  };
  /** The Site's audience as the console shows it. */
  const siteVisibility = async (who: Person, workspace: Cell["workspace"], siteId: string) => {
    const got = await f.api(who, "GET", `${sites(workspace)}/${siteId}`);
    return got.status === 200 ? String(got.json?.artifact?.visibility) : brief(got);
  };
  /**
   * A Site AI turn: the gateway starts the conversation, then the worker's
   * first database step (claim and the frozen learning policy) runs on it,
   * where the 19 October guest failure (42501) happened.
   */
  const aiTurn = async (
    workspace: Cell["workspace"],
    host: string,
    viewer: Viewer,
    options: { followUp?: boolean } = {},
  ) => {
    const started = await f.gateway(host, "POST", "/sessions", {
      ...viewer,
      body: { initialMessage: "Hello from the matrix", idempotencyKey: crypto.randomUUID() },
    });
    if (started.status !== 202) return brief(started);
    const sessionId = String(started.json.id);
    const workspaceId = f.workspaces[workspace];
    const [turn] = await shared.admin<Array<{ workflowId: string }>>`
      select temporal_workflow_id as "workflowId" from session_turns
      where session_id = ${sessionId} order by created_at desc limit 1`;
    try {
      const attemptId = crypto.randomUUID();
      const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
        sessionId,
        workflowId: turn!.workflowId,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (claim.action !== "claimed") return `202 then claim ${claim.reason}`;
      await freezeAgentLearningPolicy(client.db, {
        accountId: f.accountId,
        workspaceId,
        actor: {
          kind: "agent",
          sessionId,
          turnId: claim.turn.id,
          attemptId,
          executionGeneration: claim.turn.executionGeneration,
        },
      });
      if (!options.followUp) return "202 turn starts";
      // The turn finishes; the viewer sends again (live re-authorization).
      await shared.admin`update session_turns set status = 'completed' where session_id = ${sessionId}`;
      await shared.admin`update sessions set status = 'idle', active_turn_id = null where id = ${sessionId}`;
      const sent = await f.gateway(host, "POST", `/sessions/${sessionId}/events`, {
        ...viewer,
        body: { type: "user.message", payload: { text: "And a follow-up" } },
      });
      return sent.status === 202 ? "202 turn starts, follow-up 202" : `202 then ${brief(sent)}`;
    } catch (error) {
      return `202 then ${nestedPostgresSqlState(error) ?? String(error).slice(0, 60)}`;
    }
  };
  const siteData = (host: string, viewer: Viewer, path: string, body: unknown) =>
    f.gateway(host, "POST", `/published-artifacts/current/data/${path}`, { ...viewer, body });
  const editable = async (
    workspace: Cell["workspace"],
    who: Person,
    permission: "create" | "read" | "edit",
  ) => {
    const decision = await new PostgresEditableArtifactAuthorization(client.db).authorize({
      scope: { accountId: f.accountId, workspaceId: f.workspaces[workspace] },
      artifactId: randomBytes(16).toString("hex"),
      actor: { kind: "human", subjectId: who.subjectId },
      permission,
    } as never);
    return decision.allowed ? "allowed" : "denied";
  };
  return {
    cells,
    record,
    sites,
    createSite,
    publish,
    viewerFor,
    isViewer,
    open,
    assistantOffered,
    siteModels,
    siteVisibility,
    aiTurn,
    siteData,
    editable,
  };
}

/** The agent in a person's chat: an exact running attempt with the Site tools. */
async function agentTools(
  f: Fixture,
  workspace: "personal" | "shared",
  person: Person,
  visibility: "user_private" | "workspace_shared",
) {
  const workspaceId = f.workspaces[workspace];
  const session = await createSession(client.db, {
    accountId: f.accountId,
    workspaceId,
    initialMessage: "Make me a Site and publish it",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: person.subjectId },
    subjectId: person.subjectId,
    visibility,
  });
  const [turn] = await shared.admin<{ id: string }[]>`
    insert into session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, initiator_kind, initiator_subject_id, initiator_context
    ) values (
      ${f.accountId}, ${workspaceId}, ${session.id}, gen_random_uuid(),
      ${`matrix-wf-${crypto.randomUUID()}`}, 'running', 0, 'Make me a Site',
      'test-model', 'medium', 'none', 1, 'subject', ${person.subjectId}, '{"accepted":true}'::jsonb
    ) returning id`;
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`update sessions set active_turn_id = ${turn!.id} where id = ${session.id}`;
    await tx`update session_turns set active_attempt_id = ${attemptId} where id = ${turn!.id}`;
    await tx`insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${f.accountId}, ${workspaceId}, ${session.id}, ${turn!.id}, 1,
        'running', 'matrix-wf', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  const grant: AccessGrant = {
    accountId: f.accountId,
    workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions: ["artifacts:read", "artifacts:publish"],
    principalKind: "agent_attempt",
    metadata: {
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      executionGeneration: 1,
      firstPartyMcpTools: [
        "artifacts_create",
        "artifacts_publish",
        "site_publication_get",
        "site_publication_update",
      ],
    },
  };
  const server = buildOpenGeniMcpServer(f.deps as never, grant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "artifact-site-matrix", version: "1" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (item) => item.type === "text",
    )?.text;
    let value: any = text ?? null;
    try {
      value = JSON.parse(text ?? "null");
    } catch {
      // Plain-text tool errors.
    }
    return { isError: result.isError === true, value };
  };
  return { call, close: () => mcp.close() };
}

const toolBrief = (result: { isError: boolean; value: any }) =>
  result.isError
    ? `error ${result.value?.error?.details?.code ?? result.value?.error?.code ?? String(result.value).slice(0, 60)}`
    : "ok";

function printMatrix(cells: Cell[]) {
  const lines = cells.map(
    (cell) =>
      `${cell.actual.startsWith(cell.expected) ? "PASS" : "FAIL"} | ${cell.workspace} | ${cell.actor} | ${cell.action} | expected ${cell.expected} | actual ${cell.actual}`,
  );
  console.log(`\nArtifact and Site access matrix\n${lines.join("\n")}\n`);
  return cells.filter((cell) => !cell.actual.startsWith(cell.expected));
}

test("personal workspace: the owner and their agent create, share, publish and use Sites; others reach only what the audience allows", async () => {
  const f = await matrixFixture();
  const m = matrix(f);
  const ws = "personal" as const;
  const owner = f.owner;

  // Library: create, new version, rollback, audience, view.
  const created = await m.createSite(owner, ws, "Personal Site");
  m.record(ws, "owner", "create Site (console)", "201", brief(created));
  m.record(
    ws,
    "owner",
    "new Site audience (console)",
    "workspace",
    String(created.json?.artifact?.visibility),
  );
  const siteId = String(created.json.artifact.id);
  const v1 = String(created.json.version.id);
  const v2 = await f.api(owner, "POST", `${m.sites(ws)}/${siteId}/versions`, {
    html: html("Personal Site v2"),
    expectedCurrentVersionId: v1,
    idempotencyKey: crypto.randomUUID(),
  });
  m.record(ws, "owner", "publish new version", "200", brief(v2));
  const rollback = await f.api(owner, "POST", `${m.sites(ws)}/${siteId}/rollback`, {
    versionId: v1,
    expectedCurrentVersionId: String(v2.json?.version?.id),
    reason: "matrix",
    idempotencyKey: crypto.randomUUID(),
  });
  m.record(ws, "owner", "rollback", "200", brief(rollback));
  const privateSite = await m.createSite(owner, ws, "Only me Site", "private");
  m.record(ws, "owner", "create Only me Site", "201", brief(privateSite));
  const list = await f.api(owner, "GET", m.sites(ws));
  m.record(
    ws,
    "owner",
    "list Sites",
    "200 both",
    `${list.status} ${
      [siteId, privateSite.json?.artifact?.id].every((id) =>
        (list.json?.artifacts ?? []).some((artifact: any) => artifact.id === id),
      )
        ? "both"
        : "missing"
    }`,
  );
  for (const role of ["admin", "member", "viewer"] as const)
    m.record(
      ws,
      `org ${role} (not in workspace)`,
      "list Sites",
      "403",
      brief(await f.api(f.people[role], "GET", m.sites(ws))),
    );
  m.record(ws, "outsider", "list Sites", "403", brief(await f.api(f.outsider, "GET", m.sites(ws))));

  // Editable documents, spreadsheets and presentations share one authorization.
  for (const permission of ["create", "read", "edit"] as const)
    m.record(
      ws,
      "owner",
      `editable artifact ${permission}`,
      "allowed",
      await m.editable(ws, owner, permission),
    );
  m.record(
    ws,
    "org member (not in workspace)",
    "editable artifact read",
    "denied",
    await m.editable(ws, f.people.member, "read"),
  );

  // Publishing an Only me Site from a personal workspace.
  const privatePublish = await m.publish(owner, ws, String(privateSite.json.artifact.id), {
    access: "public",
    agent: { enabled: true },
  });
  m.record(ws, "owner", "publish Only me Site (console)", "201", brief(privatePublish));
  m.record(
    ws,
    "owner",
    "Only me Site audience after publishing",
    "workspace",
    await m.siteVisibility(owner, ws, String(privateSite.json.artifact.id)),
  );
  // A publish that fails (a hostname already in use) leaves the Site Only me.
  const unlucky = await m.createSite(owner, ws, "Unlucky Only me Site", "private");
  const unluckyId = String(unlucky.json?.artifact?.id);
  m.record(
    ws,
    "owner",
    "publish Only me Site on a taken hostname",
    "409",
    String(
      (
        await m.publish(owner, ws, unluckyId, {
          access: "public",
          label: String(privatePublish.json?.label),
        })
      ).status,
    ),
  );
  m.record(
    ws,
    "owner",
    "Only me Site audience after a failed publish",
    "private",
    await m.siteVisibility(owner, ws, unluckyId),
  );

  // The agent in an Only me chat (the default in a personal workspace).
  const agent = await agentTools(f, ws, owner, "user_private");
  try {
    const made = await agent.call("artifacts_create", {
      title: "Agent Site",
      html: html("Agent Site"),
      idempotencyKey: crypto.randomUUID(),
    });
    m.record(ws, "owner's agent (Only me chat)", "create Site", "ok", toolBrief(made));
    const agentSiteId = String(made.value?.artifact?.id);
    const agentPublish = await agent.call("site_publication_update", {
      siteId: agentSiteId,
      access: "public",
      agent: { enabled: true },
    });
    m.record(ws, "owner's agent (Only me chat)", "publish its Site", "ok", toolBrief(agentPublish));
  } finally {
    await agent.close();
  }

  // Publish for each audience, then everyone opens it and talks to its AI.
  const audiences = {
    members: await m.publish(owner, ws, siteId, { access: "members", agent: { enabled: true } }),
  } as Record<string, Result>;
  m.record(ws, "owner", "publish (members)", "201", brief(audiences.members!));
  const membersHost = String(audiences.members!.json?.hostname);
  const ownerOnMembers = await m.viewerFor(owner, membersHost);
  m.record(
    ws,
    "owner",
    "open members Site",
    "200 member",
    m.isViewer(ownerOnMembers) ? await m.open(membersHost, ownerOnMembers) : brief(ownerOnMembers),
  );
  if (m.isViewer(ownerOnMembers))
    m.record(
      ws,
      "owner",
      "Site AI turn (members Site)",
      "202 turn starts",
      await m.aiTurn(ws, membersHost, ownerOnMembers),
    );
  const orgMemberOnMembers = await m.viewerFor(f.people.member, membersHost);
  m.record(
    ws,
    "org member (not in workspace)",
    "open members Site",
    "403",
    m.isViewer(orgMemberOnMembers)
      ? await m.open(membersHost, orgMemberOnMembers)
      : brief(orgMemberOnMembers),
  );

  const invitedSite = await m.createSite(owner, ws, "Invited Site");
  const invited = await m.publish(owner, ws, String(invitedSite.json.artifact.id), {
    access: "invited",
    invitedEmails: [f.outsider.email],
    agent: { enabled: true },
  });
  m.record(ws, "owner", "publish (invited)", "201", brief(invited));
  const invitedHost = String(invited.json?.hostname);
  const ownerOnInvited = await m.viewerFor(owner, invitedHost);
  m.record(
    ws,
    "owner",
    "open invited Site",
    "200 member",
    m.isViewer(ownerOnInvited) ? await m.open(invitedHost, ownerOnInvited) : brief(ownerOnInvited),
  );
  const invitedPerson = await m.viewerFor(f.outsider, invitedHost);
  m.record(
    ws,
    "invited person",
    "open invited Site",
    "200 invited",
    m.isViewer(invitedPerson) ? await m.open(invitedHost, invitedPerson) : brief(invitedPerson),
  );
  if (m.isViewer(invitedPerson))
    m.record(
      ws,
      "invited person",
      "Site AI turn",
      "202 turn starts",
      await m.aiTurn(ws, invitedHost, invitedPerson),
    );

  const publicSite = await m.createSite(owner, ws, "Public Site");
  const publicId = String(publicSite.json.artifact.id);
  const published = await m.publish(owner, ws, publicId, {
    access: "public",
    agent: { enabled: true },
  });
  m.record(ws, "owner", "publish (anyone with the link)", "201", brief(published));
  const host = String(published.json?.hostname);
  const define = async (name: string, definition: Record<string, unknown>) =>
    await f.api(owner, "PUT", `${m.sites(ws)}/${publicId}/data/collections/${name}`, definition);
  m.record(
    ws,
    "owner",
    "define Site Data collection",
    "20",
    brief(await define("board", { accessMode: "shared", guestAccess: "read" })),
  );
  await define("guestbook", { accessMode: "append_only", guestAccess: "append" });
  const ownerWrite = await f.api(owner, "POST", `${m.sites(ws)}/${publicId}/data/write`, {
    operations: [{ op: "insert", collection: "board", data: { title: "Welcome" } }],
  });
  m.record(ws, "owner", "Site Data write (console)", "200", brief(ownerWrite));

  const viewers: Array<[string, Person | "guest", string]> = [
    ["owner", owner, "200 member"],
    ["org member (not in workspace)", f.people.member, "200 user"],
    ["outsider", f.outsider, "200 user"],
    ["guest", "guest", "200 guest"],
  ];
  for (const [actor, who, kind] of viewers) {
    const viewer = await m.viewerFor(who, host);
    if (!m.isViewer(viewer)) {
      m.record(ws, actor, "open public Site", kind, brief(viewer));
      continue;
    }
    m.record(ws, actor, "open public Site", kind, await m.open(host, viewer));
    const query = await m.siteData(host, viewer, "query", { collection: "board" });
    m.record(ws, actor, "Site Data read", "200", brief(query));
    const write = await m.siteData(host, viewer, "write", {
      operations: [
        {
          op: "insert",
          collection: actor === "owner" ? "board" : "guestbook",
          data: { text: "hi" },
        },
      ],
    });
    m.record(
      ws,
      actor,
      actor === "owner" ? "Site Data write (shared)" : "Site Data write (guestbook)",
      "200",
      brief(write),
    );
    m.record(
      ws,
      actor,
      "Site AI turn (public Site)",
      "202 turn starts",
      await m.aiTurn(ws, host, viewer),
    );
  }

  // The Site's model choice: members and everyone else get the chosen model.
  const guestDefault = await f.gateway(host, "POST", "/sessions", {
    visitor: visitorId(),
    body: { initialMessage: "Which model?" },
  });
  const [defaultRow] = await shared.admin<Array<{ model: string }>>`
    select model from sessions where id = ${String(guestDefault.json?.id)}`;
  const model = String(defaultRow?.model);
  const chosen = await m.publish(owner, ws, publicId, { agent: { enabled: true, model } });
  m.record(ws, "owner", "choose the Site AI model", "200", brief(chosen));
  const modelOf = async (viewer: Viewer) => {
    const started = await f.gateway(host, "POST", "/sessions", {
      ...viewer,
      body: { initialMessage: "Which model?" },
    });
    if (started.status !== 202) return brief(started);
    const [row] = await shared.admin<Array<{ model: string }>>`
      select model from sessions where id = ${String(started.json.id)}`;
    return row?.model === model ? "chosen model" : `other model ${row?.model}`;
  };
  const ownerViewer = await m.viewerFor(owner, host);
  if (m.isViewer(ownerViewer))
    m.record(
      ws,
      "owner",
      "Site AI uses the chosen model",
      "chosen model",
      await modelOf(ownerViewer),
    );
  m.record(
    ws,
    "guest",
    "Site AI uses the chosen model",
    "chosen model",
    await modelOf({ visitor: visitorId() }),
  );

  const mismatches = printMatrix(m.cells);
  expect(mismatches).toEqual([]);
}, 180_000);

test("shared workspace: every preset creates, publishes and uses Sites as its permissions allow", async () => {
  const f = await matrixFixture();
  const m = matrix(f);
  const ws = "shared" as const;
  const actors: Array<[string, Person, boolean]> = [
    ["owner", f.owner, true],
    ["admin", f.people.admin, true],
    ["member", f.people.member, true],
    ["viewer", f.people.viewer, false],
  ];
  const own: Record<string, { id: string; versionId: string }> = {};
  for (const [actor, who, canPublish] of actors) {
    const created = await m.createSite(who, ws, `${actor} Site`);
    m.record(ws, actor, "create Site", canPublish ? "201" : "403", brief(created));
    if (created.status === 201)
      own[actor] = {
        id: String(created.json.artifact.id),
        versionId: String(created.json.version.id),
      };
    for (const permission of ["create", "read", "edit"] as const)
      m.record(
        ws,
        actor,
        `editable artifact ${permission}`,
        canPublish || permission === "read" ? "allowed" : "denied",
        await m.editable(ws, who, permission),
      );
  }
  m.record(
    ws,
    "outsider",
    "editable artifact read",
    "denied",
    await m.editable(ws, f.outsider, "read"),
  );
  // Everyone in the workspace sees a workspace Site; nobody else does.
  for (const [actor, who] of actors) {
    const list = await f.api(who, "GET", m.sites(ws));
    m.record(
      ws,
      actor,
      "list Sites sees owner's",
      "200 yes",
      `${list.status} ${(list.json?.artifacts ?? []).some((artifact: any) => artifact.id === own.owner?.id) ? "yes" : "no"}`,
    );
  }
  m.record(ws, "outsider", "list Sites", "403", brief(await f.api(f.outsider, "GET", m.sites(ws))));
  // Each manager publishes their own Site and ships a version.
  for (const actor of ["owner", "admin", "member"] as const) {
    const who = actors.find(([name]) => name === actor)![1];
    const site = own[actor]!;
    const version = await f.api(who, "POST", `${m.sites(ws)}/${site.id}/versions`, {
      html: html(`${actor} v2`),
      expectedCurrentVersionId: site.versionId,
      idempotencyKey: crypto.randomUUID(),
    });
    m.record(ws, actor, "publish new version of own Site", "200", brief(version));
    const rollback = await f.api(who, "POST", `${m.sites(ws)}/${site.id}/rollback`, {
      versionId: site.versionId,
      expectedCurrentVersionId: String(version.json?.version?.id),
      reason: "matrix",
      idempotencyKey: crypto.randomUUID(),
    });
    m.record(ws, actor, "rollback own Site", "200", brief(rollback));
    const live = await m.publish(who, ws, site.id, { access: "public", agent: { enabled: true } });
    m.record(ws, actor, "publish own Site (anyone with the link)", "201", brief(live));
  }
  // The audience is the owner's: a private Site can be shared, by its owner only.
  const onlyMe = await m.createSite(f.people.member, ws, "Member Only me", "private");
  m.record(ws, "member", "create Only me Site", "201", brief(onlyMe));
  const onlyMeId = String(onlyMe.json?.artifact?.id);
  m.record(
    ws,
    "admin",
    "share member's Only me Site",
    "404",
    brief(
      await f.api(f.people.admin, "PUT", `${m.sites(ws)}/${onlyMeId}/visibility`, {
        visibility: "workspace",
      }),
    ),
  );
  m.record(
    ws,
    "member",
    "share own Only me Site",
    "200",
    brief(
      await f.api(f.people.member, "PUT", `${m.sites(ws)}/${onlyMeId}/visibility`, {
        visibility: "workspace",
      }),
    ),
  );
  // The agent in a member's Only me chat creates a private Site; publishing tells them to share it.
  const agent = await agentTools(f, ws, f.people.member, "user_private");
  try {
    const made = await agent.call("artifacts_create", {
      title: "Agent Site",
      html: html("Agent Site"),
      idempotencyKey: crypto.randomUUID(),
    });
    m.record(ws, "member's agent (Only me chat)", "create Site", "ok", toolBrief(made));
    m.record(
      ws,
      "member's agent (Only me chat)",
      "publish Only me Site",
      "error site_not_shared",
      toolBrief(
        await agent.call("site_publication_update", {
          siteId: String(made.value?.artifact?.id),
          access: "public",
        }),
      ),
    );
  } finally {
    await agent.close();
  }

  // The owner's public Site, opened and used by everyone.
  const host = String(
    (await f.api(f.owner, "GET", `${m.sites(ws)}/${own.owner!.id}/publication`)).json?.hostname,
  );
  const ownerSite = own.owner!.id;
  await f.api(f.owner, "PUT", `${m.sites(ws)}/${ownerSite}/data/collections/board`, {
    accessMode: "shared",
    guestAccess: "read",
  });
  await f.api(f.owner, "PUT", `${m.sites(ws)}/${ownerSite}/data/collections/guestbook`, {
    accessMode: "append_only",
    guestAccess: "append",
  });
  // A Viewer has no sessions:create, so on a Site that admits people outside
  // the workspace they use the assistant as an outside visitor would.
  const viewers: Array<[string, Person | "guest", string, string, string]> = [
    ["owner", f.owner, "200 member", "board", "202 turn starts"],
    ["admin", f.people.admin, "200 member", "board", "202 turn starts"],
    ["member", f.people.member, "200 member", "board", "202 turn starts"],
    ["viewer", f.people.viewer, "200 member", "guestbook", "202 turn starts, follow-up 202"],
    ["outsider", f.outsider, "200 user", "guestbook", "202 turn starts"],
    ["guest", "guest", "200 guest", "guestbook", "202 turn starts"],
  ];
  const publicViewers = new Map<string, Viewer>();
  for (const [actor, who, kind, collection, ai] of viewers) {
    const viewer = await m.viewerFor(who, host);
    if (!m.isViewer(viewer)) {
      m.record(ws, actor, "open public Site", kind, brief(viewer));
      continue;
    }
    publicViewers.set(actor, viewer);
    m.record(ws, actor, "open public Site", kind, await m.open(host, viewer));
    m.record(
      ws,
      actor,
      "Site AI offered (public Site)",
      "offered",
      await m.assistantOffered(host, viewer),
    );
    m.record(
      ws,
      actor,
      "Site Data read",
      "200",
      brief(await m.siteData(host, viewer, "query", { collection: "board" })),
    );
    m.record(
      ws,
      actor,
      `Site Data write (${collection})`,
      "200",
      brief(
        await m.siteData(host, viewer, "write", {
          operations: [{ op: "insert", collection, data: { text: "hi" } }],
        }),
      ),
    );
    m.record(
      ws,
      actor,
      "Site AI turn (public Site)",
      ai,
      await m.aiTurn(ws, host, viewer, { followUp: actor === "viewer" }),
    );
    if (actor === "viewer") {
      // The Viewer's conversation is an outside visitor's (Site identity and
      // limits), never a member chat they have no permission to start.
      const [conversation] = await shared.admin<Array<{ kind: string }>>`
        select viewer_kind as kind from site_runtime_conversations
        where viewer_principal = ${`user:${f.people.viewer.subjectId}`}
        order by created_at desc limit 1`;
      m.record(ws, actor, "Site AI conversation runs as", "user", conversation?.kind ?? "none");
    }
  }
  // The Viewer is offered exactly the models an outside visitor is (credit
  // billed), never the workspace catalog a member chats with.
  const outsiderModels = await m.siteModels(host, publicViewers.get("outsider")!);
  m.record(
    ws,
    "viewer",
    "Site AI models (public Site)",
    `outsider's: ${outsiderModels}`,
    `outsider's: ${await m.siteModels(host, publicViewers.get("viewer")!)}`,
  );
  // A members Site admits the workspace only.
  const membersHost = String(
    (await m.publish(f.people.member, ws, own.member!.id, { access: "members" })).json?.hostname,
  );
  for (const [actor, who, expected] of [
    ["viewer", f.people.viewer, "200 member"],
    ["outsider", f.outsider, "403"],
  ] as const) {
    const viewer = await m.viewerFor(who, membersHost);
    m.record(
      ws,
      actor,
      "open members Site",
      expected,
      m.isViewer(viewer) ? await m.open(membersHost, viewer) : brief(viewer),
    );
  }
  // A members-only Site has no outside visitors, so a Viewer has no assistant
  // there, and the page is told so.
  const viewerOnMembers = await m.viewerFor(f.people.viewer, membersHost);
  if (m.isViewer(viewerOnMembers)) {
    m.record(
      ws,
      "viewer",
      "Site AI offered (members Site)",
      "not offered",
      await m.assistantOffered(membersHost, viewerOnMembers),
    );
    m.record(
      ws,
      "viewer",
      "Site AI turn (members Site)",
      "403 not_available_for_viewer",
      await m.aiTurn(ws, membersHost, viewerOnMembers),
    );
    m.record(
      ws,
      "viewer",
      "Site AI models (members Site)",
      "none",
      (await m.siteModels(membersHost, viewerOnMembers)) || "none",
    );
  }
  // An invited Site that lists the Viewer's email: they chat as invited.
  const invitedHost = String(
    (
      await m.publish(f.people.admin, ws, own.admin!.id, {
        access: "invited",
        invitedEmails: [f.people.viewer.email],
        agent: { enabled: true },
      })
    ).json?.hostname,
  );
  const viewerOnInvited = await m.viewerFor(f.people.viewer, invitedHost);
  if (m.isViewer(viewerOnInvited)) {
    m.record(
      ws,
      "viewer",
      "open invited Site",
      "200 member",
      await m.open(invitedHost, viewerOnInvited),
    );
    m.record(
      ws,
      "viewer",
      "Site AI turn (invited Site)",
      "202 turn starts",
      await m.aiTurn(ws, invitedHost, viewerOnInvited),
    );
    const [conversation] = await shared.admin<Array<{ kind: string }>>`
      select viewer_kind as kind from site_runtime_conversations
      where viewer_principal = ${`user:${f.people.viewer.subjectId}`}
      order by created_at desc limit 1`;
    m.record(
      ws,
      "viewer",
      "invited Site AI conversation runs as",
      "invited",
      conversation?.kind ?? "none",
    );
  } else m.record(ws, "viewer", "open invited Site", "200 member", brief(viewerOnInvited));
  // In a shared workspace, publishing an Only me Site from the console still
  // asks its owner to share it first (sharing widens who can see it).
  const consolePrivate = await m.createSite(f.people.member, ws, "Console Only me", "private");
  m.record(
    ws,
    "member",
    "publish Only me Site (console)",
    "409 site_not_shared",
    brief(
      await m.publish(f.people.member, ws, String(consolePrivate.json?.artifact?.id), {
        access: "public",
      }),
    ),
  );
  m.record(
    ws,
    "member",
    "Only me Site audience after the refused publish",
    "private",
    await m.siteVisibility(f.people.member, ws, String(consolePrivate.json?.artifact?.id)),
  );
  m.record(
    ws,
    "guest",
    "open members Site",
    "401",
    await m.open(membersHost, { visitor: visitorId() }),
  );
  // Site membership is live: suspending the admin's organization membership
  // ends their member access to a members-only Site at once, even on a
  // Site session they already hold.
  const adminOnMembers = await m.viewerFor(f.people.admin, membersHost);
  if (m.isViewer(adminOnMembers)) {
    m.record(
      ws,
      "admin",
      "open members Site",
      "200 member",
      await m.open(membersHost, adminOnMembers),
    );
    await shared.admin`update organization_memberships set status = 'suspended'
      where account_id = ${f.accountId} and subject_id = ${f.people.admin.subjectId}`;
    m.record(
      ws,
      "suspended admin",
      "open members Site (existing Site session)",
      "403 site_access_denied",
      await m.open(membersHost, adminOnMembers),
    );
  } else m.record(ws, "admin", "open members Site", "200 member", brief(adminOnMembers));

  const mismatches = printMatrix(m.cells);
  expect(mismatches).toEqual([]);
}, 180_000);
