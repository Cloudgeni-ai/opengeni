import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sourceUrl = new URL("../src/", import.meta.url);

// A browser or Desktop on a Connected Machine its task has moved away from is
// retired, but only recorded so when something next uses it. Listing must not
// offer it as live: an agent that reuses a listed browser is otherwise refused.
describe("listing browsers and Desktops left on the task's former machine", () => {
  test("the listing records the move and shows them lost; others are untouched", async () => {
    const directory = await mkdtemp("/tmp/og-api-list-former-placement-");
    const script = join(directory, "synthetic-list-former-placement.ts");
    await writeFile(script, `(${listFormerPlacementFixture.toString()})()`, { mode: 0o600 });
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
            lifecycles: ["lost"],
            // Recorded as moved, what the move left on the former machine is
            // ended in the background, and the listing is read again.
            calls: ["list", "record move", "retire others", "list"],
          },
          {
            resource,
            scenario: "active on current machine",
            status: 200,
            lifecycles: ["starting"],
            calls: ["list"],
          },
          {
            resource,
            scenario: "already lost to the move",
            status: 200,
            lifecycles: ["lost"],
            calls: ["list"],
          },
          {
            resource,
            scenario: "managed placement",
            status: 200,
            lifecycles: ["starting"],
            calls: ["list"],
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

/** Drives both list routes in a separate process against a fake store. */
async function listFormerPlacementFixture() {
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
    at = "2026-10-23T12:00:00.000Z";
  const grant = {
    accountId,
    workspaceId,
    subjectId: "synthetic-user",
    principalKind: "human",
    permissions: ["sessions:read", "sessions:control"],
  };
  type State = {
    resource: "computer" | "browser";
    lifecycle: string;
    failureCode: string | null;
    managed: boolean;
    moved: boolean;
    calls: string[];
  };
  let state: State;
  const session = () => {
    const common = {
      id: resourceId,
      accountId,
      workspaceId,
      name: "Synthetic",
      lifecycle: state.lifecycle,
      placement: state.managed
        ? { kind: "sandbox_group", sandboxGroupId: randomUUID() }
        : { kind: "connected_machine", sandboxId: formerMachine },
      controller: null,
      associations: [
        {
          sessionId: sourceSessionId,
          turnId: null,
          attemptId: null,
          relationship: "created",
          actorSubjectId: grant.subjectId,
          lastUsedAt: at,
        },
      ],
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
  const list = async () => {
    state.calls.push("list");
    return { revision: 1, sessions: [session()] };
  };
  mock.module(resolveFromApi("@opengeni/db"), () => ({
    ...db,
    listBrowserSessions: list,
    listComputerSessions: list,
    getSession: async () => ({
      id: sourceSessionId,
      workspaceId,
      activeSandboxId: state.moved ? currentMachine : formerMachine,
    }),
    terminalizeStaleConnectedInteractionPlacement: async () => {
      state.calls.push("record move");
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
    listSourceFormerPlacementResources: async () => {
      state.calls.push("retire others");
      return [];
    },
  }));
  mock.module(resolveFromApi("@opengeni/core"), () => ({
    ...core,
    requireAccessGrant: async () => grant,
    requireSessionAuthorization: async () => ({}),
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
        "active on current machine",
        "already lost to the move",
        "managed placement",
      ]) {
        const lost = scenario === "already lost to the move";
        state = {
          resource,
          // Still starting: live, with no controller or Desktop bindings to fake.
          lifecycle: lost ? "lost" : "starting",
          failureCode: lost ? "source_placement_changed" : null,
          managed: scenario === "managed placement",
          moved: scenario !== "active on current machine",
          calls: [],
        };
        const response = await app.request(
          `https://api.example.test/v1/workspaces/${workspaceId}/${resource}-sessions?associatedSessionId=${sourceSessionId}&includeTerminal=false`,
        );
        const body = (await response.json()) as { sessions?: Array<{ lifecycle: string }> };
        // Let the background retirement record itself.
        await new Promise((resolve) => setTimeout(resolve, 20));
        results.push({
          resource,
          scenario,
          status: response.status,
          lifecycles: (body.sessions ?? []).map((entry) => entry.lifecycle),
          calls: state.calls,
        });
      }
    }
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  console.log(JSON.stringify(results));
}
