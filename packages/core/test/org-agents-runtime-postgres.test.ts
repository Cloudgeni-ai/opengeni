// Organization (Console) agents against real PostgreSQL: resolving the agent a
// session create names (flag, reach, drafts, archived, unpublished, strict
// mode, inline config and permissions) and the publish move of one chat
// (tool servers re-materialized, chat changes kept, deferred while busy).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { OrgAgentVersionConfig, type Permission } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import {
  OrgAgentSessionCreateError,
  prepareOrgAgentSessionCreate,
  resetOrgToolServerLiveToolsCacheForTests,
} from "../src/domain/org-agents";
import { moveSessionToOrgAgentVersion } from "../src/domain/org-agent-moves";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("org-agents-runtime-core");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const CRM_URL = "https://crm.example.com/mcp";

async function organization() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "org agents",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "org agents",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  const subjectId = grant.subjectId;
  await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
    values (${accountId}, ${workspaceId}, 'console')`;
  for (const [key, url] of [
    ["crm", CRM_URL],
    ["billing", "https://billing.example.com/mcp"],
  ] as const) {
    await shared.admin`insert into organization_tool_servers (account_id, server_key, name, url, auth_mode)
      values (${accountId}, ${key}, ${key.toUpperCase()}, ${url}, 'none')`;
  }
  async function workspace(source: "console_test" | null) {
    const id = crypto.randomUUID();
    await shared.admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'Other')`;
    await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}, ${id}) on conflict (workspace_id) do nothing`;
    if (source) {
      await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
        values (${accountId}, ${id}, ${source})`;
    }
    return id;
  }
  async function agent(
    key: string,
    versions: { instructions: string; config?: Record<string, unknown> }[],
    options: { published?: number | null; managedBy?: "console" | "code"; archived?: boolean } = {},
  ) {
    const id = crypto.randomUUID();
    await shared.admin`insert into agents (id, account_id, workspace_id, scope, visibility, name,
        name_key, origin, current_revision, agent_key, managed_by, published_revision, archived_at)
      values (${id}, ${accountId}, null, 'organization', 'workspace', ${key}, ${key}, 'app',
        ${versions.length}, ${key}, ${options.managedBy ?? "console"},
        ${options.published === undefined ? versions.length : options.published},
        ${options.archived ? new Date() : null})`;
    for (const [index, version] of versions.entries()) {
      await shared.admin`insert into agent_revisions (agent_id, account_id, workspace_id, revision,
          name, instructions, config, tool_catalog, source, config_hash)
        values (${id}, ${accountId}, null, ${index + 1}, ${key}, ${version.instructions},
          ${JSON.stringify(version.config ?? {})}::text::jsonb,
          ${JSON.stringify({ crm: [{ name: "lookup" }] })}::text::jsonb, 'console',
          ${hash(`${id}:${index}`)})`;
    }
    return id;
  }
  const settings = testSettings({ orgAgentsAccountIds: [accountId] });
  const deps = {
    db: client.db,
    settings,
    listToolServerTools: async () => ["lookup", "export"],
  };
  const grantFor = (permissions: Permission[] = ["sessions:create"]) => ({
    accountId,
    subjectId,
    permissions,
  });
  const prepare = (
    raw: Record<string, unknown>,
    options: { workspaceId?: string; permissions?: Permission[]; enabled?: boolean } = {},
  ) =>
    prepareOrgAgentSessionCreate(
      options.enabled === false ? { ...deps, settings: testSettings() } : deps,
      grantFor(options.permissions),
      options.workspaceId ?? workspaceId,
      raw,
    );
  return { accountId, workspaceId, subjectId, workspace, agent, prepare };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OrgAgentSessionCreateError)) throw error ?? new Error("not refused");
  return { status: error.httpStatus, code: error.code };
}

describe("session create with an organization agent", () => {
  test("resolves the published version by key or id and rewrites the body", async () => {
    resetOrgToolServerLiveToolsCacheForTests();
    const org = await organization();
    const agentId = await org.agent("support", [
      {
        instructions: "Be kind.",
        config: {
          model: "gpt-5",
          toolServers: [{ server: "crm", tools: { enabled: ["lookup"] }, newTools: "on" }],
        },
      },
    ]);
    for (const agent of ["support", agentId.toUpperCase(), { ref: "support" }]) {
      const prepared = await org.prepare({ initialMessage: "hi", agent });
      expect(prepared.binding).toEqual({
        agentId,
        key: "support",
        version: 1,
        promptVersion: 1,
        overrides: null,
      });
      expect(prepared.payload).toEqual({
        initialMessage: "hi",
        model: "gpt-5",
        mcpServers: [{ id: "crm", name: "CRM", url: CRM_URL, allowedTools: ["lookup", "export"] }],
      });
      expect([...prepared.agentServerIds]).toEqual(["crm"]);
    }
  }, 180_000);

  test("refusals: flag off, unknown, archived, out of reach, unpublished, conflicts", async () => {
    const org = await organization();
    await org.agent("support", [{ instructions: "Hi." }]);
    await org.agent("old", [{ instructions: "Hi." }], { archived: true });
    await org.agent("draft", [{ instructions: "Hi." }], { published: null });
    const other = await org.workspace(null);
    const notFound = { status: 404, code: "agent_not_found" };
    expect(await refusal(org.prepare({ agent: "support" }, { enabled: false }))).toEqual(notFound);
    expect(await refusal(org.prepare({ agent: "nobody" }))).toEqual(notFound);
    expect(await refusal(org.prepare({ agent: crypto.randomUUID() }))).toEqual(notFound);
    expect(await refusal(org.prepare({ agent: "Not A Key!" }))).toEqual(notFound);
    expect(await refusal(org.prepare({ agent: "old" }))).toEqual(notFound);
    expect(await refusal(org.prepare({ agent: "support" }, { workspaceId: other }))).toEqual(
      notFound,
    );
    expect(await refusal(org.prepare({ agent: "draft" }))).toEqual({
      status: 409,
      code: "agent_not_published",
    });
    expect(await refusal(org.prepare({ agent: "support", agentId: crypto.randomUUID() }))).toEqual({
      status: 422,
      code: "agent_ref_conflict",
    });
    // Strict mode: any change is refused; no change passes.
    expect(
      await refusal(org.prepare({ agent: "support", model: "other", agentOverrides: "reject" })),
    ).toEqual({ status: 422, code: "agent_override_rejected" });
    const strict = await org.prepare({ agent: "support", agentOverrides: "reject" });
    expect(strict.binding.overrides).toBeNull();
    expect(strict.payload["agentOverrides"]).toBeUndefined();
  }, 180_000);

  test("Runs on: the version's placement, the request on top, recorded and refusable", async () => {
    const org = await organization();
    await org.agent("tools-only", [{ instructions: "Hi.", config: { runsOn: { kind: "none" } } }]);
    const placed = await org.prepare({ initialMessage: "hi", agent: "tools-only" });
    expect(placed.payload).toEqual({ initialMessage: "hi", sandboxBackend: "none", rigId: null });
    expect(placed.binding.overrides).toBeNull();

    // The same placement asked for again is no change.
    const same = await org.prepare({ agent: "tools-only", sandboxBackend: "none" });
    expect(same.binding.overrides).toBeNull();

    // Code has the final say for one chat, recorded as a change.
    const own = await org.prepare({ agent: "tools-only", sandboxBackend: "modal" });
    expect(own.payload["sandboxBackend"]).toBe("modal");
    expect(own.binding.overrides).toEqual({
      runsOn: { agent: { kind: "none" }, chat: { sandboxBackend: "modal" } },
    });
    expect(
      await refusal(
        org.prepare({ agent: "tools-only", sandboxBackend: "modal", agentOverrides: "reject" }),
      ),
    ).toEqual({ status: 422, code: "agent_override_rejected" });

    // A machine the organization doesn't have is refused when a chat starts.
    await org.agent("on-box", [
      { instructions: "Hi.", config: { runsOn: { kind: "machine", machine: "Gone box" } } },
    ]);
    expect(await refusal(org.prepare({ agent: "on-box" }))).toEqual({
      status: 422,
      code: "machine_not_found",
    });
    // Unless the chat picks its own computer.
    const elsewhere = await org.prepare({ agent: "on-box", sandboxBackend: "none" });
    expect(elsewhere.payload["sandboxBackend"]).toBe("none");
  }, 180_000);

  test("drafts and explicit versions run only in the Console test workspace", async () => {
    const org = await organization();
    const agentId = await org.agent("support", [{ instructions: "v1" }, { instructions: "v2" }], {
      published: 1,
    });
    await org.agent("draft", [{ instructions: "d1" }], { published: null });
    const testWorkspace = await org.workspace("console_test");
    expect(await refusal(org.prepare({ agent: { ref: "support", version: 2 } }))).toEqual({
      status: 404,
      code: "agent_not_found",
    });
    expect((await org.prepare({ agent: { ref: "support", version: 1 } })).binding.version).toBe(1);
    expect(
      (await org.prepare({ agent: { ref: "support", version: 2 } }, { workspaceId: testWorkspace }))
        .binding,
    ).toMatchObject({ agentId, version: 2, promptVersion: 2 });
    expect(
      (await org.prepare({ agent: "draft" }, { workspaceId: testWorkspace })).binding.version,
    ).toBe(1);
    expect(
      await refusal(
        org.prepare({ agent: { ref: "support", version: 9 } }, { workspaceId: testWorkspace }),
      ),
    ).toEqual({ status: 404, code: "agent_version_not_found" });
  }, 180_000);

  test("inline config: a code agent by config hash, with agents:manage to write", async () => {
    const org = await organization();
    const config = {
      name: "Coder",
      instructions: "Write code.",
      config: { toolServers: [{ server: "crm", tools: { enabled: ["lookup"] } }] },
    };
    expect(await refusal(org.prepare({ agent: { ref: "coder", config } }))).toEqual({
      status: 403,
      code: "agents_manage_required",
    });
    const manage: Permission[] = ["sessions:create", "agents:manage"];
    const first = await org.prepare({ agent: { ref: "coder", config } }, { permissions: manage });
    expect(first.binding).toMatchObject({ key: "coder", version: 1, promptVersion: 1 });
    // The same config reuses the version, also for callers who may not write.
    const again = await org.prepare({ agent: { ref: "coder", config } });
    expect(again.binding).toEqual(first.binding);
    const [stored] = await shared.admin<
      { managed_by: string; published_revision: number | null }[]
    >`
      select managed_by, published_revision from agents where id = ${first.binding.agentId}`;
    // Inline versions are never published.
    expect(stored).toEqual({ managed_by: "code", published_revision: null });
    const changed = await org.prepare(
      { agent: { ref: "coder", config: { ...config, instructions: "Write tests." } } },
      { permissions: manage },
    );
    expect(changed.binding.version).toBe(2);
    // A published Console agent is edited in Console only.
    await org.agent("console-agent", [{ instructions: "Hi." }]);
    expect(
      await refusal(
        org.prepare({ agent: { ref: "console-agent", config } }, { permissions: manage }),
      ),
    ).toEqual({ status: 409, code: "agent_managed_in_console" });
    expect(
      await refusal(
        org.prepare(
          {
            agent: {
              ref: "coder",
              config: { ...config, config: { toolServers: [{ server: "missing" }] } },
            },
          },
          { permissions: manage },
        ),
      ),
    ).toEqual({ status: 422, code: "tool_server_not_found" });
  }, 180_000);
});

describe("publish move of one chat", () => {
  test("re-materializes tool servers, keeps the chat's, defers busy chats", async () => {
    const org = await organization();
    const v1 = { toolServers: [{ server: "crm", tools: { enabled: ["lookup"] } }] };
    const v2 = {
      toolServers: [
        { server: "crm", tools: { enabled: ["lookup", "export"] }, approval: { ask: ["export"] } },
        { server: "billing", tools: { mode: "all" } },
      ],
    };
    const agentId = await org.agent("support", [
      { instructions: "v1", config: v1 },
      { instructions: "v2", config: v2 },
    ]);
    const overrides = {
      "mcpServers.mine": { agent: null, chat: { id: "mine", url: "https://mine.example.com/mcp" } },
    };
    const create = () =>
      createSession(client.db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        initialMessage: "",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "low",
        latencyMode: "standard",
        sandboxBackend: "none",
        tools: [
          { kind: "mcp", id: "crm" },
          { kind: "mcp", id: "mine" },
        ],
        mcpServers: [
          {
            id: "crm",
            name: "CRM",
            url: CRM_URL,
            allowedTools: ["lookup"],
            headersEncrypted: { Authorization: "encrypted-login" },
          },
          { id: "mine", url: "https://mine.example.com/mcp" },
        ],
        orgAgent: { agentId, version: 1, promptVersion: 1, overrides },
      });
    const session = await create();
    const before = await getSession(client.db, org.workspaceId, session.id);
    const toolServers = new Map([
      ["crm", { key: "crm", name: "CRM", url: CRM_URL }],
      ["billing", { key: "billing", name: "BILLING", url: "https://billing.example.com/mcp" }],
    ]);
    const move = (sessionId: string) =>
      moveSessionToOrgAgentVersion(
        { db: client.db },
        {
          workspaceId: org.workspaceId,
          sessionId,
          agentId,
          to: { version: 2, config: OrgAgentVersionConfig.parse(v2), toolCatalog: {} },
          fromConfig: async (version) => (version === 1 ? OrgAgentVersionConfig.parse(v1) : null),
          toolServers,
        },
      );
    expect(await move(session.id)).toBe("moved");
    const [row] = await shared.admin<
      { agent_version: number; agent_prompt_version: number; agent_overrides: unknown }[]
    >`select agent_version, agent_prompt_version, agent_overrides from sessions where id = ${session.id}`;
    // The next turn delivers the newer Instructions; the prompt version stays.
    expect(row).toEqual({ agent_version: 2, agent_prompt_version: 1, agent_overrides: overrides });
    const servers = await shared.admin<
      {
        server_id: string;
        allowed_tools: string[] | null;
        require_approval: unknown;
        headers_encrypted: unknown;
      }[]
    >`select server_id, allowed_tools, require_approval, headers_encrypted
      from session_mcp_servers where session_id = ${session.id} order by server_id`;
    expect(servers).toEqual([
      { server_id: "billing", allowed_tools: null, require_approval: null, headers_encrypted: {} },
      {
        server_id: "crm",
        allowed_tools: ["lookup", "export"],
        require_approval: ["export"],
        headers_encrypted: { Authorization: "encrypted-login" },
      },
      { server_id: "mine", allowed_tools: null, require_approval: null, headers_encrypted: {} },
    ]);
    const after = await getSession(client.db, org.workspaceId, session.id);
    expect(after?.toolPolicyVersion).toBe((before?.toolPolicyVersion ?? 0) + 1);
    expect(after?.tools.map((tool) => tool.id).sort()).toEqual(["billing", "crm", "mine"]);
    expect(after?.orgAgent).toMatchObject({ id: agentId, version: 2 });
    const [event] = await shared.admin<{ payload: Record<string, unknown> }[]>`
      select payload from session_events where session_id = ${session.id}
        and type = 'session.tool_policy.updated' order by sequence desc limit 1`;
    expect(event?.payload["orgAgent"]).toEqual({ id: agentId, fromVersion: 1, toVersion: 2 });
    // Already on the version: nothing to do.
    expect(await move(session.id)).toBe("skipped");

    // A chat with a running turn waits.
    const busy = await create();
    await withWorkspaceSubjectSessionActivityRls(client.db, org.workspaceId, org.subjectId, (db) =>
      submitHumanPromptInTransaction(db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        sessionId: busy.id,
        subjectId: org.subjectId,
        actor: { type: "human", subjectId: org.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "work",
        resources: [],
        reasoningEffort: "low",
        reasoningEffortFallback: "low",
        source: "user",
      }),
    );
    const claimed = await claimSessionWorkForAttempt(client.db, org.workspaceId, {
      sessionId: busy.id,
      workflowId: `session-${busy.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
      agentInstructionsProtocol: 1,
      orgAgentProtocol: 1,
    });
    expect(claimed.action).toBe("claimed");
    expect(await move(busy.id)).toBe("deferred");
    const [busyRow] = await shared.admin<{ agent_version: number }[]>`
      select agent_version from sessions where id = ${busy.id}`;
    expect(busyRow?.agent_version).toBe(1);
  }, 180_000);
});
