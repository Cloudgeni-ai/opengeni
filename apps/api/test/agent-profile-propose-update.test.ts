import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { AccessGrant } from "@opengeni/contracts";
import {
  createAgentProfile,
  createDb,
  createSession,
  listAgentProfileProposals,
  sessionAgentProfileFromProfile,
  setAgentProfileStatus,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { registerAgentProfileSuggestTool } from "../src/mcp/agent-profile-suggest";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

const owl = { kind: "emoji" as const, emoji: "🦉", hue: 235 };

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_agent_profile_propose_update");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable");
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[agent-profile-propose-update] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

type Handler = (request: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

/** Registers the agent-profile tools on a stand-in server and returns one handler. */
function proposeTool(
  workspace: { accountId: string; workspaceId: string },
  sessionId: string,
  settings: Settings,
) {
  const handlers = new Map<string, Handler>();
  registerAgentProfileSuggestTool({
    server: {
      registerTool: (name: string, _definition: unknown, handler: Handler) =>
        handlers.set(name, handler),
    } as never,
    deps: { db: client.db, settings },
    grant: { ...workspace, subjectId: "user:davlet" } as AccessGrant,
    sessionId,
    authorize: async () => undefined,
    json: (value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] }),
  });
  const handler = handlers.get("agent_profile_propose_update")!;
  return async (request: Record<string, unknown>) =>
    JSON.parse((await handler(request)).content[0]!.text) as Record<string, unknown>;
}

async function session(
  workspace: { accountId: string; workspaceId: string },
  agentProfile?: ReturnType<typeof sessionAgentProfileFromProfile>,
) {
  return await createSession(client.db, {
    ...workspace,
    initialMessage: "review",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
    ...(agentProfile ? { agentProfile } : {}),
  });
}

describe("agent_profile_propose_update", () => {
  test("records a pending proposal against the version the chat sees", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const profile = await createAgentProfile(client.db, {
      ...workspace,
      name: "Annie",
      avatar: owl,
      config: { agent: { instructions: "Review pull requests." } },
    });
    const chat = await session(workspace, sessionAgentProfileFromProfile(profile));
    const propose = proposeTool(workspace, chat.id, testSettings() as Settings);

    expect(
      await propose({ instructions: "Review pull requests.", reason: "Nothing new." }),
    ).toMatchObject({ status: "not_proposed", code: "unchanged" });

    const result = await propose({
      instructions: "Review pull requests. Always link the failing check.",
      reason: "The user wants failing checks linked in every review.",
    });
    expect(result).toMatchObject({
      type: "agent_profile_proposal",
      status: "proposed",
      profileId: profile.id,
      profileName: "Annie",
      baseVersion: 1,
    });
    const pending = await listAgentProfileProposals(client.db, {
      workspaceId: workspace.workspaceId,
      subjectId: "user:davlet",
      profileId: profile.id,
    });
    expect(pending).toEqual([
      expect.objectContaining({
        id: result.proposalId,
        sessionId: chat.id,
        proposedBy: "user:davlet",
        baseVersion: 1,
        status: "pending",
      }),
    ]);
    // Nothing changes until a person accepts.
    expect(
      (
        await shared!.admin<{ version: number }[]>`
        select version from agent_profiles where id = ${profile.id}`
      )[0]!.version,
    ).toBe(1);
  });

  test("declines without a saved agent, with an archived agent, or with the flag off", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const plain = await session(workspace);
    const request = { instructions: "Be brief.", reason: "The user prefers short answers." };
    expect(
      await proposeTool(workspace, plain.id, testSettings() as Settings)(request),
    ).toMatchObject({
      status: "not_proposed",
      code: "no_saved_agent",
    });

    const profile = await createAgentProfile(client.db, {
      ...workspace,
      name: "Scout",
      avatar: owl,
      config: {},
    });
    const chat = await session(workspace, sessionAgentProfileFromProfile(profile));
    expect(
      await proposeTool(
        workspace,
        chat.id,
        testSettings({ agentProfilesEnabled: false }) as Settings,
      )(request),
    ).toMatchObject({ status: "not_proposed", code: "unavailable" });

    await setAgentProfileStatus(client.db, {
      workspaceId: workspace.workspaceId,
      profileId: profile.id,
      status: "archived",
    });
    expect(
      await proposeTool(workspace, chat.id, testSettings() as Settings)(request),
    ).toMatchObject({
      status: "not_proposed",
      code: "agent_unavailable",
    });
  });
});
