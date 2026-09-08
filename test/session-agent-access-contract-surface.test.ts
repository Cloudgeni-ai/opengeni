import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionAuthorizationOperationForHttp } from "../apps/api/src/routes/sessions";
import { FIRST_PARTY_TOOL_AUTHORIZATION } from "../apps/api/src/mcp/first-party-tool-permissions";

// ---------------------------------------------------------------------------
// Agent-access scope contract surface (migration 0423).
//
// A session's agentAccess ("session" | "user" | "workspace") and end-user
// label are enforced in exactly one place: the core session-authorization
// seam (`requireSessionAuthorization` for a target read/write and
// `requireSessionAuthorizationListScope` + `sessionAuthorizationScopeFilter`
// for lists). That only holds while every agent-reachable target-session read
// actually passes through the seam. This test pins the complete entry-point
// inventory so a new `/sessions/:sessionId/...` route or a new first-party
// MCP tool that names a target session cannot bypass the fence silently.
// ---------------------------------------------------------------------------

const repo = join(import.meta.dir, "..");
const SESSION_ROUTES = "apps/api/src/routes/sessions.ts";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ROUTE_PATTERN = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gu;

/**
 * Operations whose routes deliberately skip the generic middleware. Each is
 * verified below to reach the seam through its own path.
 */
const MIDDLEWARE_EXEMPT_OPERATIONS = {
  // The long-lived stream performs its own initial check plus bounded
  // reauthorization inside the handler.
  "session.stream.read": { handlerMarker: "requireSessionAuthorization(" },
  // Managed-human-only product mutations: core runs the target-free gates
  // first and then the seam exactly once (packages/core/src/application/session-tenancy.ts).
  "session.visibility.write": { handlerMarker: "updateManagedHumanSessionVisibility(" },
  "session.fork.create": { handlerMarker: "forkManagedHumanSession(" },
} as const;

/** Route files registered outside the session module: the middleware does not
 * cover them, so each handler must call the seam itself. */
const OUT_OF_MODULE_HANDLER_MARKERS = [
  "requireSessionAuthorization(",
  "requireAgentSessionAccess(",
];

/**
 * First-party MCP tools that name a target session but delegate the seam
 * call to a core command. Each entry pins the delegate that appears in the
 * tool body and the core file that calls the seam for it.
 */
const MCP_DELEGATED_TOOLS: Record<
  string,
  { delegate: string; coreFile: string; coreMarker: string }
> = {
  session_pause: {
    delegate: "controlAgentSessionWorkstream(",
    coreFile: "packages/core/src/application/session-commands.ts",
    coreMarker: "authorizeAgentSessionCommand(",
  },
  session_resume: {
    delegate: "controlAgentSessionWorkstream(",
    coreFile: "packages/core/src/application/session-commands.ts",
    coreMarker: "authorizeAgentSessionCommand(",
  },
  session_steer: {
    delegate: "steerAgentSession(",
    coreFile: "packages/core/src/application/session-commands.ts",
    coreMarker: "authorizeAgentSessionCommand(",
  },
  scheduled_tasks_create: {
    delegate: "createValidatedScheduledTask(",
    coreFile: "packages/core/src/domain/scheduled-tasks.ts",
    coreMarker: "requireSessionAuthorization(",
  },
  scheduled_tasks_update: {
    delegate: "updateScheduledTask",
    coreFile: "packages/core/src/domain/scheduled-tasks.ts",
    coreMarker: "requireSessionAuthorization(",
  },
};

async function sourceFiles(root: string, pattern = "**/*.ts"): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob(pattern).scan({ cwd: join(repo, root) })) {
    files.push(join(root, path));
  }
  return files.sort();
}

async function read(file: string): Promise<string> {
  return await readFile(join(repo, file), "utf8");
}

type RouteRegistration = { method: string; path: string; index: number; body: string };

function sessionRoutes(source: string): RouteRegistration[] {
  const routes: RouteRegistration[] = [];
  for (const match of source.matchAll(ROUTE_PATTERN)) {
    const path = match[2]!;
    if (!path.includes("/sessions/:sessionId")) continue;
    const index = match.index ?? 0;
    const next = source.indexOf("\n  app.", index + 1);
    routes.push({
      method: match[1]!.toUpperCase(),
      path,
      index,
      body: source.slice(index, next === -1 ? source.length : next),
    });
  }
  return routes;
}

function samplePathname(path: string): string {
  return path
    .replace(":workspaceId", "22222222-2222-4222-8222-222222222222")
    .replace(":sessionId", SESSION_ID)
    .replace(/:[A-Za-z]+/gu, "x");
}

describe("agent-access scope stays enforced at every session entry point", () => {
  test("the HTTP session module fences every /sessions/:sessionId route through the middleware or an explicit seam path", async () => {
    const source = await read(SESSION_ROUTES);
    const middlewareAt = source.indexOf(
      'app.use("/v1/workspaces/:workspaceId/sessions/:sessionId/*", authorizeSessionHttp);',
    );
    expect(middlewareAt).toBeGreaterThan(0);
    expect(source).toContain(
      'await requireSessionAuthorization(deps, grant, {\n        sessionId,\n        operation,\n        surface: "http",\n      });',
    );
    const routes = sessionRoutes(source);
    expect(routes.length).toBeGreaterThan(60);
    for (const route of routes) {
      expect(
        route.index,
        `${route.method} ${route.path} is registered before the session authorization middleware`,
      ).toBeGreaterThan(middlewareAt);
      const operation = sessionAuthorizationOperationForHttp(
        route.method,
        samplePathname(route.path),
        SESSION_ID,
      );
      expect(
        operation,
        `${route.method} ${route.path} has no session authorization operation; the middleware would fail closed (503) instead of authorizing it. Classify it in sessionAuthorizationOperationForHttp.`,
      ).not.toBeNull();
      const exemption =
        MIDDLEWARE_EXEMPT_OPERATIONS[operation as keyof typeof MIDDLEWARE_EXEMPT_OPERATIONS];
      if (exemption) {
        expect(
          route.body.includes(exemption.handlerMarker),
          `${route.method} ${route.path} bypasses the middleware and must reach the seam through ${exemption.handlerMarker}`,
        ).toBe(true);
      }
    }
    // The exemptions are exactly the three the middleware skips.
    for (const operation of Object.keys(MIDDLEWARE_EXEMPT_OPERATIONS)) {
      expect(source).toContain(`operation === "${operation}"`);
    }
    const tenancy = await read("packages/core/src/application/session-tenancy.ts");
    expect(tenancy).toContain('operation: "session.visibility.write"');
    expect(tenancy).toContain('operation: "session.fork.create"');
  });

  test("session routes registered outside the session module call the seam themselves", async () => {
    let found = 0;
    for (const file of await sourceFiles("apps/api/src/routes")) {
      if (file === SESSION_ROUTES) continue;
      const source = await read(file);
      for (const route of sessionRoutes(source)) {
        found += 1;
        expect(
          OUT_OF_MODULE_HANDLER_MARKERS.some((marker) => route.body.includes(marker)),
          `${file}: ${route.method} ${route.path} names a target session but never calls requireSessionAuthorization; the session middleware does not cover routes registered by other modules.`,
        ).toBe(true);
      }
    }
    // files.ts (two retained-artifact routes) and machines.ts (active-sandbox).
    expect(found).toBeGreaterThanOrEqual(3);
  });

  test("every first-party MCP tool that names a target session reaches the seam", async () => {
    const catalogued = new Set(Object.keys(FIRST_PARTY_TOOL_AUTHORIZATION));
    const seen = new Set<string>();
    for (const file of await sourceFiles("apps/api/src/mcp")) {
      const source = await read(file);
      const chunks = source.split(/registerTool\(/gu);
      for (let index = 1; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const name = chunk.match(/^\s*"([^"]+)"/u)?.[1];
        if (!name || !catalogued.has(name)) continue;
        const takesTargetSession =
          /\b(sessionId|session_id|sourceSessionId|targetSessionId)\s*:\s*z4?\s*\./u.test(chunk) ||
          /\btargets\s*:\s*z4?\s*\./u.test(chunk);
        if (!takesTargetSession) continue;
        seen.add(name);
        const direct =
          chunk.includes("authorizeFirstPartySession(") ||
          chunk.includes("requireSessionAuthorization(");
        const delegated = MCP_DELEGATED_TOOLS[name];
        if (direct) continue;
        expect(
          delegated,
          `${file}: MCP tool ${name} takes a target session id but never authorizes it through authorizeFirstPartySession; add the call or register its core delegate here with proof.`,
        ).toBeDefined();
        expect(
          chunk.includes(delegated!.delegate),
          `${file}: MCP tool ${name} no longer calls its registered seam delegate ${delegated!.delegate}`,
        ).toBe(true);
        expect(await read(delegated!.coreFile)).toContain(delegated!.coreMarker);
      }
    }
    for (const name of [
      "session_get",
      "session_events",
      "session_wait",
      "session_send_message",
      "session_human_input_respond",
      "set_other_session_title",
      ...Object.keys(MCP_DELEGATED_TOOLS),
    ]) {
      expect(seen.has(name), `expected ${name} to be inventoried as a target-session tool`).toBe(
        true,
      );
    }
  });

  test("the pairwise rule and its list predicate live only in the seam and the database filter", async () => {
    const seam = await read("packages/core/src/session-authorization.ts");
    expect(seam).toContain("export function agentAccessPermitsCrossTreeAccess(");
    expect(seam).toContain("export function agentAccessListScopeForViewer(");
    expect(seam).toContain(
      'if (actor.kind === "agent_attempt" && target.rootSessionId !== actor.callerRootSessionId) {',
    );
    expect(seam).toContain("!agentAccessPermitsCrossTreeAccess(callerAccess, {");
    expect(seam).toContain(
      "return viewer ? agentAccessListScopeForViewer(viewer, hostScope) : hostScope;",
    );
    const db = await read("packages/db/src/index.ts");
    expect(db).toContain("export function sessionAgentAccessViewerFilter(");
    expect(db).toContain(
      "? and(hostScope, sessionAgentAccessViewerFilter(scope.agentAccessViewer))!",
    );
    for (const root of [
      "apps/api/src",
      "apps/worker/src",
      "packages/runtime/src",
      "packages/sdk/src",
      "packages/react/src",
    ]) {
      for (const file of await sourceFiles(root)) {
        const content = await read(file);
        expect(
          content.includes("agentAccessPermitsCrossTreeAccess") ||
            content.includes("sessionAgentAccessViewerFilter("),
          `${file} must not re-implement the agent-access rule; call the seam instead.`,
        ).toBe(false);
      }
    }
  });

  test("browser and computer inventories are filtered through the seam for agent attempts", async () => {
    for (const file of [
      "apps/api/src/routes/browser-sessions.ts",
      "apps/api/src/routes/computer-sessions.ts",
    ]) {
      const source = await read(file);
      expect(source).toContain("filterInteractionSessionsForGrant(deps, grant, listed.sessions)");
      expect(source).toContain(
        'await authorizeSourceSession(deps, grant, record.sourceSessionId, "session.read");',
      );
    }
    const filter = await read("apps/api/src/interaction-agent-access.ts");
    expect(filter).toContain("grantHasAgentAttemptAuthority(grant)");
    expect(filter).toContain('operation: "session.read"');
  });
});
