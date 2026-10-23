import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sourceUrl = new URL("../src/", import.meta.url);

// A browser or Desktop opened on one Connected Machine stays live there after
// its task moves to another machine, until something uses or ends it. One
// End must end it, stopping its controller on the former machine, rather than
// failing on the move and leaving it lost for a second End.
describe("ending a browser or Desktop left live on the task's former machine", () => {
  test("one End retires it there and ends it; an unreachable machine still refuses", async () => {
    const directory = await mkdtemp("/tmp/og-api-end-former-placement-");
    const script = join(directory, "synthetic-end-former-placement.ts");
    await writeFile(script, `(${endFormerPlacementFixture.toString()})()`, { mode: 0o600 });
    const child = Bun.spawn([process.execPath, "--no-env-file", script, sourceUrl.href], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const results = JSON.parse(stdout) as Array<Record<string, unknown>>;
      for (const resource of ["computer", "browser"]) {
        expect(results.filter((result) => result.resource === resource)).toEqual([
          {
            resource,
            scenario: "active on former machine",
            status: 200,
            lifecycle: "ended",
            // Recorded as moved, retired on the former machine, any other
            // resource the move left there retired in the background, then
            // ended in the control plane with no controller left to reach.
            calls: ["record move", "retire this on former", "retire others", "prepare", "complete"],
          },
          {
            resource,
            scenario: "former machine unreachable",
            status: 409,
            lifecycle: "lost",
            calls: ["record move", "retire this on former"],
            stillRunsThere: true,
          },
          {
            resource,
            scenario: "already lost to the move",
            status: 200,
            lifecycle: "ended",
            calls: ["retire this on former", "prepare", "complete"],
          },
          {
            resource,
            scenario: "active on current machine",
            status: 500,
            lifecycle: "active",
            // Not moved: nothing is recorded, and the end goes to its
            // controller as before.
            calls: [
              "prepare",
              "controller",
              ...(resource === "browser" ? ["restore prepared end"] : []),
            ],
          },
        ]);
      }
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

/** Drives both End routes in a separate process against a fake store, a fake
 * former-machine retirement and a controller route that only records use. */
async function endFormerPlacementFixture() {
  const sourceHref = process.argv[2]!;
  const apiDirectory = new URL("..", sourceHref).pathname;
  const resolveFromApi = (name: string) => Bun.resolveSync(name, apiDirectory);
  const { mock } = await import("bun:test");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = (await import(resolveFromApi("hono"))) as typeof import("hono");
  const db = (await import(resolveFromApi("@opengeni/db"))) as typeof import("@opengeni/db");
  const core = (await import(resolveFromApi("@opengeni/core"))) as typeof import("@opengeni/core");
  const { testSettings } = (await import(
    resolveFromApi("@opengeni/testing")
  )) as typeof import("@opengeni/testing");
  const accountId = randomUUID(),
    workspaceId = randomUUID(),
    resourceId = randomUUID(),
    sourceSessionId = randomUUID(),
    formerMachine = randomUUID(),
    currentMachine = randomUUID(),
    controllerGeneration = randomUUID(),
    at = "2026-10-23T12:00:00.000Z";
  const grant = {
    accountId,
    workspaceId,
    subjectId: "synthetic-user",
    principalKind: "human",
    permissions: ["sessions:read", "sessions:control"],
  };
  const placement = { kind: "connected_machine", sandboxId: formerMachine };
  type State = {
    resource: "computer" | "browser";
    lifecycle: string;
    failureCode: string | null;
    bound: boolean;
    moved: boolean;
    reachable: boolean;
    calls: string[];
  };
  let state: State;
  const session = () => {
    const controller = state.bound
      ? { controllerId: "opengeni-browserd", controllerGeneration, placementInstanceId: "instance" }
      : null;
    const common = {
      id: resourceId,
      accountId,
      workspaceId,
      name: "Synthetic",
      lifecycle: state.lifecycle,
      placement,
      controller,
      associations: [],
      createdBySubjectId: grant.subjectId,
      createdAt: at,
      lastUsedAt: at,
      failureCode: state.failureCode,
    };
    return state.resource === "computer"
      ? {
          ...common,
          platform: null,
          adapter: null,
          seatId: null,
          displayId: null,
          capabilities: null,
        }
      : {
          ...common,
          driverId: "opengeni.cdp.v1",
          engine: "chromium",
          engineVersion: null,
          headless: true,
          identityId: null,
          baseRevisionId: null,
          networkRouteId: null,
          linkedComputerSessionId: null,
          capabilities: db.MANAGED_BROWSER_SESSION_CAPABILITIES,
        };
  };
  const record = () => ({
    sourceSessionId,
    tokenGeneration: 1,
    controllerHostSandboxGroupId: null,
    networkRouteAuthority: null,
    deviceWorkspaceId: null,
    session: session(),
  });
  const receipt = (operationId: string, settled: boolean) => ({
    operationId,
    resourceKind: state.resource === "computer" ? "computer_session" : "browser_session",
    resourceId,
    kind: "end",
    state: settled ? "completed" : "prepared",
    replayed: false,
    error: null,
    createdAt: at,
    dispatchedAt: null,
    settledAt: settled ? at : null,
  });
  const prepare = async (_db: unknown, input: { operationId: string }) => {
    state.calls.push("prepare");
    return { session: session(), operation: receipt(input.operationId, false) };
  };
  const complete = async (_db: unknown, input: { operationId: string }) => {
    state.calls.push("complete");
    state.lifecycle = "ended";
    state.failureCode = null;
    state.bound = false;
    return { session: session(), operation: receipt(input.operationId, true) };
  };
  mock.module(resolveFromApi("@opengeni/db"), () => ({
    ...db,
    getComputerSessionControlRecord: async () => record(),
    getBrowserSessionControlRecord: async () => record(),
    getSession: async () => ({
      id: sourceSessionId,
      workspaceId,
      activeSandboxId: state.moved ? currentMachine : formerMachine,
    }),
    terminalizeStaleConnectedInteractionPlacement: async () => {
      state.calls.push("record move");
      if (!state.moved) {
        return {
          sourcePlacementChanged: false,
          changed: false,
          browserSessionIds: [],
          computerSessionIds: [],
          revision: 1,
        };
      }
      state.lifecycle = "lost";
      state.failureCode = "source_placement_changed";
      return {
        sourcePlacementChanged: true,
        changed: true,
        browserSessionIds: state.resource === "browser" ? [resourceId] : [],
        computerSessionIds: state.resource === "computer" ? [resourceId] : [],
        revision: 2,
      };
    },
    interactionControllerGone: async () => false,
    prepareComputerSessionEnd: prepare,
    prepareBrowserSessionEnd: prepare,
    completeComputerSessionEnd: complete,
    completeBrowserSessionEnd: complete,
    failPreparedBrowserSessionEnd: async () => {
      state.calls.push("restore prepared end");
    },
  }));
  mock.module(resolveFromApi("@opengeni/core"), () => ({
    ...core,
    requireAccessGrant: async () => grant,
    requireSessionAuthorization: async () => ({}),
  }));
  const retirementHref = new URL("./former-placement-retirement.ts", sourceHref).href;
  const retirement = await import(retirementHref);
  mock.module(retirementHref, () => ({
    ...retirement,
    retireFormerPlacementControllers: async (
      _services: unknown,
      input: {
        connectedSandboxId: string;
        browserSessionIds: string[];
        computerSessionIds: string[];
      },
    ) => {
      const ids = [...input.browserSessionIds, ...input.computerSessionIds];
      state.calls.push(
        input.connectedSandboxId === formerMachine && ids.length === 1 && ids[0] === resourceId
          ? "retire this on former"
          : "retire unexpected",
      );
      if (!state.reachable) return { retired: [], remaining: ids, unreachable: true };
      state.bound = false;
      return { retired: ids, remaining: [], unreachable: false };
    },
    retireSourceFormerPlacements: async () => {
      state.calls.push("retire others");
      return [];
    },
  }));
  const channelHref = new URL("./sandbox/channel-a.ts", sourceHref).href;
  const channel = await import(channelHref);
  const controllerRoute = async () => {
    state.calls.push("controller");
    throw new Error("synthetic controller route");
  };
  mock.module(channelHref, () => ({
    ...channel,
    withChannelA: controllerRoute,
    withChannelARead: controllerRoute,
  }));
  const { registerComputerSessionRoutes } = await import(
    new URL("./routes/computer-sessions.ts", sourceHref).href
  );
  const { registerBrowserSessionRoutes } = await import(
    new URL("./routes/browser-sessions.ts", sourceHref).href
  );
  const app = new Hono();
  app.onError((error, context) =>
    context.json(
      { message: error.message },
      ((error as { status?: number }).status ?? 500) as never,
    ),
  );
  const deps = {
    settings: testSettings({ delegationSecret: "synthetic-controller-authority" }),
    db: {},
    bus: {},
  } as never;
  registerComputerSessionRoutes(app, deps);
  registerBrowserSessionRoutes(app, deps);
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  const results = [];
  try {
    for (const resource of ["computer", "browser"] as const) {
      for (const scenario of [
        "active on former machine",
        "former machine unreachable",
        "already lost to the move",
        "active on current machine",
      ]) {
        const lost = scenario === "already lost to the move";
        state = {
          resource,
          lifecycle: lost ? "lost" : "active",
          failureCode: lost ? "source_placement_changed" : null,
          bound: true,
          moved: scenario !== "active on current machine",
          reachable: scenario !== "former machine unreachable",
          calls: [],
        };
        const response = await app.request(
          `https://api.example.test/v1/workspaces/${workspaceId}/${resource}-sessions/${resourceId}/end`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId: randomUUID() }),
          },
        );
        const body = (await response.json()) as { message?: string };
        const result: Record<string, unknown> = {
          resource,
          scenario,
          status: response.status,
          lifecycle: state.lifecycle,
          calls: state.calls,
        };
        if (response.status === 409) {
          result.stillRunsThere = String(body.message).includes(
            "still runs on the Connected Machine its task moved away from",
          );
        }
        results.push(result);
      }
    }
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  console.log(JSON.stringify(results));
}
