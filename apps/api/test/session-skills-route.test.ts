import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  SessionSkills,
  signDelegatedAccessToken,
  type FirstPartyMcpToolName,
  type Permission,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  initializeSessionStartAtomically,
  listSessionEvents,
  type DbClient,
} from "@opengeni/db";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { Hono } from "hono";
import { createApp } from "../src/app";

// PUT .../sessions/:id/skills replaces the Skills a session carries itself,
// with the shared tool-policy CAS; an agent may only remove Skills.

const SECRET = "session-skills-route-test-secret";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-session-skills-route");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

const ENVIRONMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 43).toString("base64");
const settings = () =>
  testSettings({
    productAccessMode: "managed",
    delegationSecret: SECRET,
    environmentsEncryptionKey: ENVIRONMENTS_ENCRYPTION_KEY,
    sandboxBackend: "none",
  });

function app(): Hono {
  const noop = async () => undefined;
  return createApp({
    settings: settings(),
    db: client.db,
    bus: new MemoryEventBus(),
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
  } as Parameters<typeof createApp>[0]);
}

async function fixture(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-skills-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Session Skills",
    workspaceExternalSource: "session-skills-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session Skills",
    subjectId: `user:${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

async function humanBearer(grant: Grant): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:read", "sessions:control", "sessions:create"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

const skill = (name: string, body = `${name} steps.`) => ({
  files: [
    { path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${name} guide\n---\n${body}` },
  ],
});

async function rootSession(grant: Grant, names: string[]) {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "root",
    resources: [],
    skills: SessionSkills.parse(names.map((name) => skill(name))),
    tools: [],
    metadata: {},
    model: settings().openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools: ["session_create"] as FirstPartyMcpToolName[],
    createdBy: { kind: "subject", subjectId: grant.subjectId, label: "Test owner" },
    createdByContext: {},
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  return session;
}

async function agentBearer(grant: Grant, sessionId: string): Promise<string> {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("test attempt was not claimed");
  const permissions: Permission[] = ["sessions:read", "sessions:control", "workspace:read"];
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions,
    principalKind: "agent_attempt",
    sessionId,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    firstPartyMcpTools: ["session_create"],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function putSkills(
  target: Hono,
  bearer: string,
  grant: Grant,
  sessionId: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const response = await target.request(
    `/v1/workspaces/${grant.workspaceId}/sessions/${sessionId}/skills`,
    {
      method: "PUT",
      headers: { authorization: bearer, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, json: await response.json().catch(() => null) };
}

const names = (skills: Array<{ name: string }>) => skills.map((entry) => entry.name);

describe("replacing a session's Skills (real PostgreSQL)", () => {
  test("a person replaces the Skills with the shared version check", async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    const bearer = await humanBearer(grant);
    const session = await rootSession(grant, ["quarterly-close"]);
    const version = session.toolPolicyVersion;

    const replaced = await putSkills(target, bearer, grant, session.id, {
      skills: [skill("quarterly-close", "Updated steps."), skill("board-pack")],
      expectedVersion: version,
    });
    expect(replaced.status).toBe(200);
    expect(names(replaced.json.skills)).toEqual(["quarterly-close", "board-pack"]);
    expect(replaced.json.toolPolicyVersion).toBe(version + 1);
    const stored = await getSession(client.db, grant.workspaceId, session.id);
    expect(stored?.skills[0]?.files[0]?.content).toContain("Updated steps.");
    const events = await listSessionEvents(client.db, grant.workspaceId, session.id);
    expect(events.find((event) => event.type === "session.skills.updated")?.payload).toEqual({
      before: ["quarterly-close"],
      after: ["quarterly-close", "board-pack"],
      version: version + 1,
      effectiveFrom: "next_attempt",
    });

    const stale = await putSkills(target, bearer, grant, session.id, {
      skills: [],
      expectedVersion: version,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.currentVersion).toBe(version + 1);

    const unchanged = await putSkills(target, bearer, grant, session.id, {
      skills: [skill("quarterly-close", "Updated steps."), skill("board-pack")],
      expectedVersion: version + 1,
    });
    expect(unchanged.status).toBe(200);
    expect(unchanged.json.toolPolicyVersion).toBe(version + 1);

    const invalid = await putSkills(target, bearer, grant, session.id, {
      skills: [{ files: [{ path: "README.md", content: "no SKILL.md" }] }],
      expectedVersion: version + 1,
    });
    expect(invalid.status).toBe(422);

    const cleared = await putSkills(target, bearer, grant, session.id, {
      skills: [],
      expectedVersion: version + 1,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.json.skills).toEqual([]);
  });

  test("an agent can remove a Skill but not add or change one", async () => {
    if (!available) return;
    const grant = await fixture();
    const target = app();
    const session = await rootSession(grant, ["quarterly-close", "board-pack"]);
    const bearer = await agentBearer(grant, session.id);
    const version = session.toolPolicyVersion;

    for (const skills of [
      [skill("quarterly-close"), skill("board-pack"), skill("new-skill")],
      [skill("quarterly-close", "Rewritten steps.")],
    ]) {
      const refused = await putSkills(target, bearer, grant, session.id, {
        skills,
        expectedVersion: version,
      });
      expect(refused.status).toBe(403);
    }
    const removed = await putSkills(target, bearer, grant, session.id, {
      skills: [skill("board-pack")],
      expectedVersion: version,
    });
    expect(removed.status).toBe(200);
    expect(names(removed.json.skills)).toEqual(["board-pack"]);
  });
});
