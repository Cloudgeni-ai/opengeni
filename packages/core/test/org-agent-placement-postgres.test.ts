// Where an organization (Console) agent chat finally lands, through the real
// session create against the production database posture (non-superuser
// owner, FORCE RLS, restricted runtime login): a machine outside its reach is
// refused and works once its reach includes the workspace, a Personal (Only
// me) machine is refused whether the request names it, the person's own
// default would pick it, or a worker would join its parent's box on it, and a
// version keeps the machine it was saved with when another one takes its name.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AccessGrant } from "@opengeni/contracts";
import {
  createDb,
  createWorkspace,
  ensureManagedAccessForUser,
  getSession,
  updateOrganizationMachineReach,
  type DbClient,
} from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  grantDeferredRuntimeAccess,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import postgres from "postgres";
import type { ApiRouteDeps } from "../src";
import type { AccessGrantAuthorization } from "../src/access";
import { OrgAgentSessionCreateError } from "../src/domain/org-agents";
import { createSessionForRequest } from "../src/domain/sessions";

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
let app: postgres.Sql;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("org-agent-placement");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
  app = postgres(shared.appUrl, {
    max: 2,
    prepare: false,
    connection: { search_path: shared.schema },
    onnotice: () => undefined,
  });
}, 900_000);
afterAll(async () => {
  await app?.end({ timeout: 1 }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const MEMBER_PERMISSIONS = JSON.stringify([
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "rigs:use",
  "enrollments:read",
]);

/** An organization whose owner's shared workspace (home) its product manages. */
async function organization() {
  const userId = `placement-${crypto.randomUUID()}`;
  const owner = `user:${userId}`;
  const managed = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Organization owner",
  });
  const grant = managed.workspaceGrants.find(
    (candidate) => candidate.workspaceId === managed.defaultWorkspaceId,
  )!;
  const { accountId } = grant;
  const home = grant.workspaceId!;
  await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
    values (${accountId}, ${home}, 'console')`;
  const second = (await createWorkspace(client.db, { accountId, name: "Second" })).id;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${second}, ${owner}, 'owner', ${MEMBER_PERMISSIONS}::jsonb)`;

  async function machine(scope: "organization" | "user", workspaceId: string, name: string) {
    return (await app.begin(async (tx) => {
      await tx`select
        set_config('opengeni.account_id', ${accountId}, true),
        set_config('opengeni.workspace_id', ${workspaceId}, true),
        set_config('opengeni.subject_id', ${owner}, true)`;
      const [row] = await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
        select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
        from finalize_scoped_enrollment(
          ${accountId}::uuid, ${workspaceId}::uuid, ${scope},
          ${`ed25519:placement-${crypto.randomUUID()}`}, false, false, 'linux', 'x86_64',
          ${name}, ${scope === "organization"}
        )`;
      return row!;
    })) as { enrollmentId: string; sandboxId: string };
  }

  async function agent(
    key: string,
    config: Record<string, unknown> = {},
    runsOnTarget: Record<string, string> | null = null,
  ) {
    const id = crypto.randomUUID();
    await shared.admin`insert into agents (id, account_id, workspace_id, scope, visibility, name,
        name_key, origin, current_revision, agent_key, managed_by, published_revision)
      values (${id}, ${accountId}, null, 'organization', 'workspace', ${key}, ${key}, 'app',
        1, ${key}, 'console', 1)`;
    await shared.admin`insert into agent_revisions (agent_id, account_id, workspace_id, revision,
        name, instructions, config, tool_catalog, source, config_hash, runs_on_target)
      values (${id}, ${accountId}, null, 1, ${key}, 'Help.', ${JSON.stringify(config)}::text::jsonb,
        '{}'::jsonb, 'console',
        ${`sha256:${createHash("sha256").update(id).digest("hex")}`},
        ${runsOnTarget === null ? null : JSON.stringify(runsOnTarget)}::text::jsonb)`;
    return id;
  }

  const noop = async () => undefined;
  const deps = {
    db: client.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      sandboxBackend: "none",
      sandboxOwnershipEnabled: true,
      sandboxSelfhostedEnabled: true,
      orgAgentsAccountIds: [accountId],
    }),
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: noop, requestSessionWorkflowWakeDispatch: noop },
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  const authorization = (caller: AccessGrant) =>
    ({
      grant: caller,
      accountGrant: managed.accountGrants[0] ?? null,
      authenticatedSubjectId: owner,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    }) satisfies AccessGrantAuthorization;
  /** The owner, signed in, starts a chat in the managed workspace. */
  const create = async (body: Record<string, unknown>, caller: AccessGrant = grant) => {
    const created = await createSessionForRequest(
      deps,
      caller,
      home,
      { initialMessage: "Synthetic chat; never execute a model", ...body },
      authorization(caller),
    );
    return (await getSession(client.db, home, created.id))!;
  };
  return { accountId, owner, home, second, grant, machine, agent, create };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OrgAgentSessionCreateError)) throw error ?? new Error("not refused");
  return { status: error.httpStatus, code: error.code };
}

const PERSONAL = { status: 422, code: "personal_machine_not_allowed" };

describe("where an organization agent chat lands", () => {
  test("a chat's own machine must reach the workspace; then it is used", async () => {
    const org = await organization();
    await org.agent("helper");
    // Connected from another workspace and kept there.
    const box = await org.machine("organization", org.second, "Second box");
    const reach = (allowManagedWorkspaces: boolean) =>
      updateOrganizationMachineReach(client.db, box.enrollmentId, {
        accountId: org.accountId,
        homeWorkspaceId: org.second,
        allowedWorkspaceIds: [],
        allowPersonalWorkspaces: false,
        allowManagedWorkspaces,
        subjectId: org.owner,
      });
    await reach(false);
    expect(await refusal(org.create({ agent: "helper", targetSandboxId: box.sandboxId }))).toEqual({
      status: 422,
      code: "runs_on_unavailable",
    });

    await reach(true);
    const chat = await org.create({ agent: "helper", targetSandboxId: box.sandboxId });
    expect(chat.activeSandboxId).toBe(box.sandboxId);
    expect(chat.orgAgent?.key).toBe("helper");
  }, 180_000);

  test("a Personal machine named by the request is refused", async () => {
    const org = await organization();
    await org.agent("helper");
    await org.agent("on-box", { runsOn: { kind: "none" } });
    const laptop = await org.machine("user", org.home, "My laptop");
    for (const agent of ["helper", "on-box"]) {
      expect(await refusal(org.create({ agent, targetSandboxId: laptop.sandboxId }))).toEqual(
        PERSONAL,
      );
    }
  }, 180_000);

  test("the person's own default machine is not used for an organization agent chat", async () => {
    const org = await organization();
    await org.agent("helper");
    const laptop = await org.machine("user", org.home, "My laptop");
    await shared.admin`insert into workspace_member_execution_defaults
        (account_id, workspace_id, subject_id, target)
      values (${org.accountId}, ${org.home}, ${org.owner},
        ${JSON.stringify({ kind: "machine", targetSandboxId: laptop.sandboxId })}::text::jsonb)`;
    // Their ordinary chats start there.
    const own = await org.create({});
    expect(own.activeSandboxId).toBe(laptop.sandboxId);
    // An organization agent chat does not.
    const chat = await org.create({ agent: "helper" });
    expect(chat.activeSandboxId).toBeNull();
    expect(chat.orgAgent?.key).toBe("helper");
  }, 180_000);

  test("a worker doesn't join its parent's box on a Personal machine", async () => {
    const org = await organization();
    await org.agent("helper");
    const laptop = await org.machine("user", org.home, "My laptop");
    const parent = await org.create({ targetSandboxId: laptop.sandboxId });
    expect(parent.activeSandboxId).toBe(laptop.sandboxId);
    const fromParent: AccessGrant = {
      ...org.grant,
      metadata: { ...org.grant.metadata, sessionId: parent.id },
    };
    // A worker naming an organization agent, sharing by default or explicitly.
    for (const sandbox of [undefined, "shared" as const]) {
      expect(
        await refusal(org.create({ agent: "helper", ...(sandbox ? { sandbox } : {}) }, fromParent)),
      ).toEqual(PERSONAL);
    }
    // Its own computer is fine.
    const own = await org.create({ agent: "helper", sandbox: "new" }, fromParent);
    expect(own.activeSandboxId).toBeNull();
  }, 180_000);

  test("a version keeps its machine when another one takes its name", async () => {
    const org = await organization();
    const box = await org.machine("organization", org.home, "Build box");
    await org.agent(
      "on-box",
      { runsOn: { kind: "machine", machine: "Build box" } },
      { machineId: box.enrollmentId },
    );
    await org.agent("by-name", { runsOn: { kind: "machine", machine: "Build box" } });
    await org.machine("organization", org.home, "Build box");
    // Saved by id: still the first machine.
    const chat = await org.create({ agent: "on-box" });
    expect(chat.activeSandboxId).toBe(box.sandboxId);
    // A version saved before ids were kept resolves the name and finds two.
    expect(await refusal(org.create({ agent: "by-name" }))).toEqual({
      status: 422,
      code: "machine_not_found",
    });
  }, 180_000);
});
