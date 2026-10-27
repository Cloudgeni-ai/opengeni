import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  OPENGENI_CALLING_WORKSPACE_HEADER,
  organizationAccessPresetPermissions,
  signCallingWorkspaceProof,
} from "@opengeni/contracts";
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
import {
  appActionContentFlow,
  withAppActionContentFlow,
  type SessionAdminReach,
} from "../src/mcp/session-admin-access-tools";
import {
  OTHER_WORKSPACE_SESSION_TOOLS,
  reachSessionInOtherWorkspace,
  type OtherWorkspaceSessionTool,
} from "../src/mcp/session-other-workspace";
import {
  contentFlowCheckFailure,
  REGION_RESTRICTED_TOOL_MESSAGE,
  requireCallingWorkspaceContentFlow,
  withOtherWorkspaceContentFlow,
} from "../src/mcp/workspace-content-flow";

/* A session reaching another workspace of its organization never carries
   EU-only content into a workspace that isn't EU-only, in either direction,
   and never runs anything when that can't be checked; another organization's
   workspace is left to its route, which never says whether it exists. The
   setting is the organization's today, so a refusal between two workspaces of
   one organization can't be set up yet: the checks themselves are covered in
   packages/db/test/workspace-content-flow.test.ts. Opengeni's own MCP
   endpoints refuse an agent of a workspace that isn't EU-only reaching EU-only
   content. */

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

/** Another workspace of the same organization. */
async function sameOrganization(of: WorkspaceContentFlowEnd): Promise<WorkspaceContentFlowEnd> {
  const workspaceId = crypto.randomUUID();
  await shared.admin`
    insert into workspaces (id, account_id, name) values (${workspaceId}, ${of.accountId}, 'Research')`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}, ${of.accountId})`;
  return { accountId: of.accountId, workspaceId };
}

/** The real database until `fail()`, then unreadable: a setting that can't be read mid-call. */
function failingLater(db: Database) {
  let failed = false;
  const proxy = new Proxy(db, {
    get: (target, property, receiver) => {
      if (failed && property !== "then") throw new Error("database unavailable");
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, fail: () => (failed = true) };
}

const NOT_REACHABLE = "Session not found or access denied";
const ok: CallToolResult = { content: [{ type: "text", text: "the answer" }] };

describe("session tools in another workspace", () => {
  test("EU-only to EU-only in one organization runs every tool", async () => {
    const here = await workspace(true);
    const there = await sameOrganization(here);
    for (const tool of OTHER_WORKSPACE_SESSION_TOOLS) {
      const { ran } = await reachOther(here, there, tool);
      expect(ran).toBe(true);
    }
  });

  test("another organization's workspace is answered by its route, never by its setting", async () => {
    for (const [hereEuOnly, thereEuOnly] of [
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const here = await workspace(hereEuOnly);
      const there = await workspace(thereEuOnly);
      for (const tool of OTHER_WORKSPACE_SESSION_TOOLS) {
        const { result, ran } = await reachOther(here, there, tool);
        // The route runs as the person in this organization and denies it,
        // exactly as for a workspace that doesn't exist.
        expect(ran).toBe(true);
        expect(textOf(result)).toContain(NOT_REACHABLE);
        expect(textOf(result)).not.toContain("EU-only");
      }
    }
  });

  test("nothing runs when the setting can't be read", async () => {
    const here = await workspace(false);
    const there = await sameOrganization(here);
    for (const tool of ["session_get", "session_send_message"] as const) {
      const { result, ran } = await reachOther(here, there, tool, unreadableDb());
      expect(ran).toBe(false);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Nothing was run");
    }
  });

  test("an answer that comes back after the setting can't be read is withheld", async () => {
    const here = await workspace(true);
    const there = await sameOrganization(here);
    const later = failingLater(client.db);
    const result = await withOtherWorkspaceContentFlow(
      later.db,
      { here, thereWorkspaceId: there.workspaceId, flow: "from_there" },
      async () => {
        later.fail();
        return ok;
      },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("The answer isn't shown");
    // Unchanged, the answer comes back.
    expect(
      await withOtherWorkspaceContentFlow(
        client.db,
        { here, thereWorkspaceId: there.workspaceId, flow: "from_there" },
        async () => ok,
      ),
    ).toBe(ok);
  });

  test("a refusal reads plainly, before and after the call", () => {
    const refused = new WorkspaceContentFlowRefusedError(crypto.randomUUID(), crypto.randomUUID());
    expect(textOf(contentFlowCheckFailure(refused))).toBe(REGION_RESTRICTED_TOOL_MESSAGE);
    expect(textOf(contentFlowCheckFailure(refused, "after"))).toContain(
      "Not supported in EU-only workspaces",
    );
    expect(textOf(contentFlowCheckFailure(refused, "after"))).toContain("The answer isn't shown");
    expect(textOf(contentFlowCheckFailure(new Error("x")))).toContain("Retry");
  });
});

describe("admin_action_call in another workspace", () => {
  const read = "GET /v1/workspaces/:workspaceId/vaults";
  const readWithText = "POST /v1/workspaces/:workspaceId/knowledge/entries/search";
  const change = "POST /v1/workspaces/:workspaceId/tools/invoke";
  const call = (id: string, there: WorkspaceContentFlowEnd) => ({
    id,
    pathParameters: { workspaceId: there.workspaceId },
  });
  async function run(db: Database, here: WorkspaceContentFlowEnd, input: ReturnType<typeof call>) {
    let ran = false;
    const result = await withAppActionContentFlow(db, here, input, async () => {
      ran = true;
      return ok;
    });
    return { result, ran };
  }

  test("only a read that sends nothing but ids and paging keys just brings content here", () => {
    const flow = (id: string, input: { query?: Record<string, unknown>; body?: unknown }) =>
      appActionContentFlow(findAppAction(id)!, input);
    expect(appActionChangesState(findAppAction(read)!)).toBe(false);
    expect(appActionChangesState(findAppAction(readWithText)!)).toBe(false);
    expect(flow(read, {})).toBe("from_there");
    expect(flow(read, { query: { limit: 5, cursor: "c", sessionId: "s" }, body: {} })).toBe(
      "from_there",
    );
    expect(flow(read, { query: { q: "our launch plan" } })).toBe("both_ways");
    expect(flow(readWithText, { body: { query: "our launch plan" } })).toBe("both_ways");
    expect(flow(change, {})).toBe("both_ways");
  });

  test("EU-only to EU-only in one organization runs reads and changes", async () => {
    const here = await workspace(true);
    const there = await sameOrganization(here);
    for (const id of [read, readWithText, change]) {
      const { ran } = await run(client.db, here, call(id, there));
      expect(ran).toBe(true);
    }
  });

  test("another organization's workspace is left to its route", async () => {
    for (const [hereEuOnly, thereEuOnly] of [
      [true, false],
      [false, true],
    ] as const) {
      const here = await workspace(hereEuOnly);
      const there = await workspace(thereEuOnly);
      for (const id of [read, change]) {
        const { result, ran } = await run(client.db, here, call(id, there));
        expect(ran).toBe(true);
        expect(result).toBe(ok);
      }
    }
  });

  test("its own workspace and actions without a workspace aren't moves", async () => {
    const here = await workspace(false);
    // Nothing is read, so even an unreadable setting doesn't matter.
    expect((await run(unreadableDb(), here, call(change, here))).ran).toBe(true);
    expect(
      (
        await run(unreadableDb(), here, {
          id: "GET /v1/organizations/:organizationId/workspaces",
          pathParameters: { organizationId: here.accountId, workspaceId: crypto.randomUUID() },
        })
      ).ran,
    ).toBe(true);
  });

  test("nothing runs when the setting can't be read", async () => {
    const here = await workspace(false);
    const there = await sameOrganization(here);
    const { result, ran } = await run(unreadableDb(), here, call(read, there));
    expect(ran).toBe(false);
    expect(textOf(result)).toContain("Nothing was run");
  });
});

describe("Opengeni's own MCP endpoints called from another workspace", () => {
  const secret = "workspace-content-flow-mcp-secret";
  const settings = testSettings({ productAccessMode: "managed", delegationSecret: secret });
  const request = async (calling?: WorkspaceContentFlowEnd | string) =>
    new Request("http://opengeni.test/v1/mcp", {
      method: "POST",
      headers:
        calling === undefined
          ? {}
          : {
              [OPENGENI_CALLING_WORKSPACE_HEADER]:
                typeof calling === "string"
                  ? calling
                  : await signCallingWorkspaceProof(secret, calling),
            },
    });

  test("EU-only content reaches only an EU-only calling workspace", async () => {
    const eu = await workspace(true);
    const euElsewhere = await workspace(true);
    const other = await workspace(false);
    const deps = { db: client.db, settings };
    // A workspace, and every workspace of an organization.
    for (const reached of [{ workspaceId: eu.workspaceId }, { accountId: eu.accountId }]) {
      await expect(
        requireCallingWorkspaceContentFlow(deps, await request(other), reached),
      ).rejects.toBeInstanceOf(WorkspaceContentFlowRefusedError);
      await requireCallingWorkspaceContentFlow(deps, await request(euElsewhere), reached);
      await requireCallingWorkspaceContentFlow(deps, await request(eu), reached);
    }
    // Content that isn't EU-only may go to an EU-only workspace.
    for (const reached of [{ workspaceId: other.workspaceId }, { accountId: other.accountId }]) {
      await requireCallingWorkspaceContentFlow(deps, await request(eu), reached);
    }
  });

  test("a request naming no workspace isn't a workspace agent; a bad proof is refused", async () => {
    const eu = await workspace(true);
    const deps = { db: client.db, settings };
    await requireCallingWorkspaceContentFlow(deps, await request(), { accountId: eu.accountId });
    for (const proof of ["ogcw_forged.signature", "not-a-proof"]) {
      await expect(
        requireCallingWorkspaceContentFlow(deps, await request(proof), {
          accountId: eu.accountId,
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  test("refused when the setting can't be read", async () => {
    const other = await workspace(false);
    const deps = { db: unreadableDb(), settings };
    for (const reached of [{ workspaceId: other.workspaceId }, { accountId: other.accountId }]) {
      await expect(
        requireCallingWorkspaceContentFlow(deps, await request(other), reached),
      ).rejects.toThrow("database unavailable");
    }
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
