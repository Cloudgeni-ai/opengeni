import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { organizationAccessPresetPermissions } from "@opengeni/contracts";
import { appActionChangesState, findAppAction } from "@opengeni/contracts/app-actions";
import {
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  updateOrganizationInferenceResidency,
  WorkspaceContentFlowRefusedError,
  type Database,
  type DbClient,
  type WorkspaceContentFlowEnd,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import { regionRestrictedHttpError } from "../src/http/api-error";
import { appActionOtherWorkspaceRefusal } from "../src/mcp/session-admin-access-tools";
import type { SessionAdminReach } from "../src/mcp/session-admin-access-tools";
import {
  OTHER_WORKSPACE_SESSION_TOOLS,
  reachSessionInOtherWorkspace,
  type OtherWorkspaceSessionTool,
} from "../src/mcp/session-other-workspace";
import { REGION_RESTRICTED_TOOL_MESSAGE } from "../src/mcp/workspace-content-flow";

/* A session reaching another workspace never carries EU-only content into a
   workspace that isn't EU-only, in either direction, and never runs anything
   when that can't be checked. Two organizations stand in for two workspaces
   with different settings: today the setting is the organization's. */

setDefaultTimeout(120_000);
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-content-flow-mcp");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  // As the runtime will once 0981 grants the change function; tests turn EU-only on.
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

async function workspace(euOnly: boolean): Promise<WorkspaceContentFlowEnd> {
  const userId = `eu-flow-mcp-${crypto.randomUUID()}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "EU-only owner",
  });
  const membership = provisioned.organizationMemberships[0]!;
  if (euOnly) {
    await updateOrganizationInferenceResidency(client.db, {
      organizationId: membership.organizationId,
      actorSubjectId: `user:${userId}`,
      actorKind: "browser_person",
      euOnly: true,
      expectedVersion: 0,
      operationId: crypto.randomUUID(),
    });
  }
  return { accountId: membership.organizationId, workspaceId: membership.personalWorkspaceId };
}

function textOf(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

/** A database whose every read fails, as when the setting can't be read. */
function unreadableDb(): Database {
  return new Proxy({} as Database, {
    get: (_target, property) =>
      property === "then"
        ? undefined
        : () => {
            throw new Error("database unavailable");
          },
  });
}

/** Full access whose dispatch records whether anything ran in the other workspace. */
function fullAccess(here: WorkspaceContentFlowEnd) {
  const dispatched: string[] = [];
  const reach: SessionAdminReach = {
    authority: async () => {
      throw new Error("not used");
    },
    actAs: () => {
      throw new Error("not used");
    },
    fullAccessPerson: async () => ({
      caller: {
        kind: "person",
        accountId: here.accountId,
        subjectId: "user:eu-flow-person",
        access: {
          preset: "full",
          permissions: organizationAccessPresetPermissions("full"),
          workspaceScope: { kind: "all" },
        },
      },
      origin: "http://opengeni.test",
      dispatch: async (request: Request) => {
        dispatched.push(new URL(request.url).pathname);
        return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
      },
    }),
  };
  return { reach, dispatched };
}

async function reachOther(
  here: WorkspaceContentFlowEnd,
  there: WorkspaceContentFlowEnd,
  toolName: OtherWorkspaceSessionTool,
  db = client.db,
) {
  const { reach: sessionReach, dispatched } = fullAccess(here);
  const result = await reachSessionInOtherWorkspace({
    reach: sessionReach,
    db,
    here,
    workspaceId: there.workspaceId,
    toolName,
    arguments: { sessionId: crypto.randomUUID() },
  });
  return { result, ran: dispatched.length > 0 };
}

const SENDS = new Set<OtherWorkspaceSessionTool>(["session_send_message", "session_steer"]);

describe("session tools in another workspace", () => {
  test("EU-only to EU-only runs every tool", async () => {
    const here = await workspace(true);
    const there = await workspace(true);
    for (const tool of OTHER_WORKSPACE_SESSION_TOOLS) {
      const { ran } = await reachOther(here, there, tool);
      expect(ran).toBe(true);
    }
  });

  test("an EU-only session never sends or steers into a workspace that isn't EU-only", async () => {
    const here = await workspace(true);
    const there = await workspace(false);
    for (const tool of OTHER_WORKSPACE_SESSION_TOOLS) {
      const { result, ran } = await reachOther(here, there, tool);
      // Reading a chat there only brings its content into this EU-only workspace.
      expect(ran).toBe(!SENDS.has(tool));
      if (SENDS.has(tool)) {
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(REGION_RESTRICTED_TOOL_MESSAGE);
      }
    }
  });

  test("a session that isn't EU-only never reads or reaches an EU-only chat", async () => {
    const here = await workspace(false);
    const there = await workspace(true);
    for (const tool of OTHER_WORKSPACE_SESSION_TOOLS) {
      const { result, ran } = await reachOther(here, there, tool);
      expect(ran).toBe(false);
      expect(textOf(result)).toBe(REGION_RESTRICTED_TOOL_MESSAGE);
    }
  });

  test("nothing runs when the setting can't be read", async () => {
    const here = await workspace(false);
    const there = await workspace(false);
    const closed = { db: unreadableDb() };
    for (const tool of ["session_get", "session_send_message"] as const) {
      const { result, ran } = await reachOther(here, there, tool, closed.db);
      expect(ran).toBe(false);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Nothing was run");
    }
  });
});

describe("admin_action_call in another workspace", () => {
  const read = "GET /v1/workspaces/:workspaceId/vaults";
  const change = "POST /v1/workspaces/:workspaceId/tools/invoke";
  const call = (id: string, there: WorkspaceContentFlowEnd) => ({
    id,
    pathParameters: { workspaceId: there.workspaceId },
  });

  test("the fixture actions are a read and a change", () => {
    expect(appActionChangesState(findAppAction(read)!)).toBe(false);
    expect(appActionChangesState(findAppAction(change)!)).toBe(true);
  });

  test("EU-only to EU-only runs reads and changes", async () => {
    const here = await workspace(true);
    const there = await workspace(true);
    expect(await appActionOtherWorkspaceRefusal(client.db, here, call(read, there))).toBeNull();
    expect(await appActionOtherWorkspaceRefusal(client.db, here, call(change, there))).toBeNull();
  });

  test("an EU-only session reads elsewhere but never changes a workspace that isn't EU-only", async () => {
    const here = await workspace(true);
    const there = await workspace(false);
    expect(await appActionOtherWorkspaceRefusal(client.db, here, call(read, there))).toBeNull();
    const refused = await appActionOtherWorkspaceRefusal(client.db, here, call(change, there));
    expect(refused?.isError).toBe(true);
    expect(textOf(refused!)).toBe(REGION_RESTRICTED_TOOL_MESSAGE);
  });

  test("a session that isn't EU-only never reads or changes an EU-only workspace", async () => {
    const here = await workspace(false);
    const there = await workspace(true);
    for (const id of [read, change]) {
      const refused = await appActionOtherWorkspaceRefusal(client.db, here, call(id, there));
      expect(textOf(refused!)).toBe(REGION_RESTRICTED_TOOL_MESSAGE);
    }
  });

  test("its own workspace and actions without a workspace aren't moves", async () => {
    const here = await workspace(false);
    const closed = { db: unreadableDb() };
    // Nothing is read, so even an unreadable setting doesn't matter.
    expect(await appActionOtherWorkspaceRefusal(closed.db, here, call(change, here))).toBeNull();
    expect(
      await appActionOtherWorkspaceRefusal(closed.db, here, {
        id: "GET /v1/organizations/:organizationId/workspaces",
        pathParameters: { organizationId: here.accountId, workspaceId: crypto.randomUUID() },
      }),
    ).toBeNull();
  });

  test("nothing runs when the setting can't be read", async () => {
    const here = await workspace(false);
    const there = await workspace(false);
    const closed = { db: unreadableDb() };
    const refused = await appActionOtherWorkspaceRefusal(closed.db, here, call(read, there));
    expect(textOf(refused!)).toContain("Nothing was run");
  });
});

test("the API answers a refused move with 422 region_restricted", async () => {
  const error = regionRestrictedHttpError(
    new WorkspaceContentFlowRefusedError(crypto.randomUUID(), crypto.randomUUID()),
  );
  expect(error?.status).toBe(422);
  expect(error?.code).toBe("region_restricted");
  expect(error?.retryable).toBe(false);
  expect(error?.message).toContain("Not supported in EU-only workspaces");
  expect(regionRestrictedHttpError(new Error("other"))).toBeNull();

  // Through the app's one error mapping, as every route raising it is answered.
  const app = createApp({
    settings: testSettings({ databaseUrl: shared.adminUrl }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  app.get("/region-restricted-probe", () => {
    throw new WorkspaceContentFlowRefusedError(crypto.randomUUID(), crypto.randomUUID());
  });
  const response = await app.request("/region-restricted-probe");
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: { status: 422, code: "region_restricted", retryable: false },
  });
});
