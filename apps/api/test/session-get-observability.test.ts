import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { currentTraceContext, withTraceContext, type Span } from "@opengeni/observability";

const source = readFileSync(new URL("../src/routes/sessions.ts", import.meta.url), "utf8");
const parsed = parseSync("sessions.ts", source);
expect(parsed.errors).toEqual([]);
const declarations = parsed.program.body
  .map((node) => (node.type === "ExportNamedDeclaration" ? node.declaration : node))
  .filter((node) => node?.type === "FunctionDeclaration");

function declaration(name: string): string {
  const found = declarations.find((node) => node?.id?.name === name);
  if (!found) throw new Error(`Missing production declaration: ${name}`);
  return source.slice(found.start, found.end);
}

let handler: any;
function visit(node: any): void {
  if (!node || typeof node !== "object") return;
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.name === "app" &&
    node.callee.property?.name === "get" &&
    node.arguments[0]?.value === "/v1/workspaces/:workspaceId/sessions/:sessionId"
  ) {
    handler = node.arguments[1];
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") visit(value);
  }
}
visit(parsed.program);
if (!handler) throw new Error("Missing production session GET route");
const transpiler = new Bun.Transpiler({ loader: "ts" });
const measure = new Function(
  "withTraceContext",
  transpiler.transformSync(
    `${declaration("measureSessionGetPhase")}; return measureSessionGetPhase;`,
  ),
)(withTraceContext);
const productionRoute = new Function(
  "ports",
  "deps",
  "db",
  `const { requireAccessGrant, getSessionForSubject, relatedSessionAccessFor,
    backgroundCommandActivityForSessions, scheduledSessionIds, hasPermission,
    withEffectivePolicy, measureSessionGetPhase, z, HTTPException } = ports;
    ${transpiler.transformSync(`const route = ${source.slice(handler.start, handler.end)};`)}
    return route;`,
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
const parent = { traceId: "1".repeat(32), spanId: "2".repeat(16) };

function observer() {
  const names: string[] = [];
  const endings: unknown[] = [];
  return {
    names,
    endings,
    startSpan(name: string): Span {
      names.push(name);
      return { ...parent, spanId: "3".repeat(16), end: (value) => void endings.push(value) };
    },
  };
}

function fixture(
  permissions = ["sessions:read", "scheduled_tasks:run", "sessions:control"],
  transaction = false,
) {
  const holds = {
    authorization: deferred<any>(),
    session: deferred<any>(),
    activity: deferred<any>(),
    schedules: deferred<any>(),
    projection: deferred<any>(),
  };
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const o = observer();
  const deps = { observability: o };
  const db = transaction ? { rollback: () => undefined } : {};
  const grant = { accountId: "account", subjectId: "subject", permissions };
  const session = {
    id: "session",
    initialMessage: "private prompt",
    agent: { capabilities: "all" },
  };
  const c = {
    req: { param: (name: string) => (name === "workspaceId" ? "workspace" : "session") },
    json: (body: unknown) => body,
  };
  const read = (name: keyof typeof holds, ...args: unknown[]) => {
    calls.push({ name, args });
    return holds[name].promise;
  };
  const ports = {
    requireAccessGrant: (...args: unknown[]) => read("authorization", ...args),
    getSessionForSubject: (...args: unknown[]) => read("session", ...args),
    relatedSessionAccessFor: () => "target",
    backgroundCommandActivityForSessions: (...args: unknown[]) => read("activity", ...args),
    scheduledSessionIds: (...args: unknown[]) => read("schedules", ...args),
    hasPermission: (values: string[], permission: string) => values.includes(permission),
    withEffectivePolicy: (...args: unknown[]) => read("projection", ...args),
    measureSessionGetPhase: measure,
    z: { string: () => ({ uuid: () => ({ safeParse: () => ({ success: true }) }) }) },
    HTTPException: class extends Error {},
  };
  return {
    holds,
    calls,
    o,
    grant,
    session,
    c,
    db,
    deps,
    run: () => productionRoute(ports, deps, db)(c),
  };
}

test("production GET authorizes and reads the session before overlapping joined enrichments", async () => {
  const f = fixture();
  let finished = false;
  const running = f.run().then((result: unknown) => {
    finished = true;
    return result;
  });
  expect(f.calls.map((call) => call.name)).toEqual(["authorization"]);
  expect(f.calls[0]!.args).toEqual([f.c, f.deps, "workspace", "sessions:read"]);
  f.holds.authorization.resolve(f.grant);
  await flush();
  expect(f.calls.map((call) => call.name)).toEqual(["authorization", "session"]);
  expect(f.calls[1]!.args).toEqual([f.db, "workspace", "session", "subject", "target"]);
  f.holds.session.resolve(f.session);
  await flush();
  expect(f.calls.map((call) => call.name)).toEqual([
    "authorization",
    "session",
    "activity",
    "schedules",
    "projection",
  ]);
  expect(f.calls[4]!.args).toEqual([f.deps, "workspace", "subject", f.session]);
  f.holds.projection.resolve({ ...f.session, effectiveTools: { privatePolicy: "not telemetry" } });
  f.holds.schedules.resolve(new Set(["session"]));
  await flush();
  expect(finished).toBe(false);
  f.holds.activity.resolve(new Map([["session", { running: 1 }]]));
  expect(await running).toEqual({
    ...f.session,
    effectiveTools: { privatePolicy: "not telemetry" },
    hasSchedules: true,
    backgroundCommandActivity: { running: 1 },
  });
  expect(f.o.names).toEqual([
    "api.session_get.authorization",
    "api.session_get.session_read",
    "api.session_get.background_commands",
    "api.session_get.schedules",
    "api.session_get.response_projection",
  ]);
  expect(f.o.endings).toEqual(
    Array.from({ length: 5 }, () => ({ attributes: { outcome: "completed" } })),
  );
});

test.each([
  ["sessions:read"],
  ["sessions:read", "scheduled_tasks:run"],
  ["sessions:read", "sessions:control"],
])("schedule enrichment requires both permissions: %j", async (...permissions) => {
  const f = fixture(permissions);
  const running = f.run();
  f.holds.authorization.resolve(f.grant);
  f.holds.session.resolve(f.session);
  await flush();
  expect(f.calls.some((call) => call.name === "schedules")).toBe(false);
  f.holds.activity.resolve(new Map());
  f.holds.projection.resolve(f.session);
  expect(await running).toEqual({ ...f.session, hasSchedules: false });
});

test("all failed enrichments settle before the original activity error wins", async () => {
  const f = fixture();
  const activityError = new Error("private activity failure");
  const scheduleError = new Error("private schedule failure");
  const projectionError = new Error("private projection failure");
  let finished = false;
  const running = f.run().catch((error: unknown) => {
    finished = true;
    return error;
  });
  f.holds.authorization.resolve(f.grant);
  f.holds.session.resolve(f.session);
  await flush();
  f.holds.projection.reject(projectionError);
  f.holds.activity.reject(activityError);
  await flush();
  expect(finished).toBe(false);
  f.holds.schedules.reject(scheduleError);
  expect(await running).toBe(activityError);
  expect(JSON.stringify(f.o.endings)).not.toContain("private");
});

test("transaction-bound GET keeps enrichment reads serial", async () => {
  const f = fixture(undefined, true);
  const running = f.run();
  f.holds.authorization.resolve(f.grant);
  f.holds.session.resolve(f.session);
  await flush();
  expect(f.calls.map((call) => call.name)).toEqual(["authorization", "session", "activity"]);
  f.holds.activity.resolve(new Map());
  await flush();
  expect(f.calls.at(-1)?.name).toBe("schedules");
  expect(f.calls.some((call) => call.name === "projection")).toBe(false);
  f.holds.schedules.resolve(new Set());
  await flush();
  expect(f.calls.at(-1)?.name).toBe("projection");
  f.holds.projection.resolve(f.session);
  expect(await running).toEqual({ ...f.session, hasSchedules: false });
});

test("schedule errors precede projection errors and a missing session starts no enrichment", async () => {
  const f = fixture();
  const scheduleError = new Error("schedule failure");
  const running = f.run().catch((error: unknown) => error);
  f.holds.authorization.resolve(f.grant);
  f.holds.session.resolve(f.session);
  await flush();
  f.holds.activity.resolve(new Map());
  f.holds.schedules.reject(scheduleError);
  f.holds.projection.reject(new Error("projection failure"));
  expect(await running).toBe(scheduleError);
  const missing = fixture();
  const failed = missing.run().catch((error: unknown) => error);
  missing.holds.authorization.resolve(missing.grant);
  missing.holds.session.resolve(null);
  expect(await failed).toBeInstanceOf(Error);
  expect(missing.calls.map((call) => call.name)).toEqual(["authorization", "session"]);
});

test("projection shares one workspace promise, joins failures, and never caches across calls", async () => {
  const loader = new Function(
    "ports",
    transpiler.transformSync(`
      const { requireWorkspace, workspaceSessionToolPolicyContext, workspaceSessionEffectiveToolsContext } = ports;
      ${declaration("loadEffectivePolicyContext")}; return loadEffectivePolicyContext;`),
  );
  const workspace = { settings: { humanInputEnabled: true } };
  const reads: Promise<unknown>[] = [];
  let count = 0;
  const ports = {
    requireWorkspace: async () => {
      count++;
      return workspace;
    },
    workspaceSessionToolPolicyContext: async (
      _db: unknown,
      _id: string,
      _settings: unknown,
      _subject: string,
      read: Promise<unknown>,
    ) => {
      reads.push(read);
      expect(await read).toBe(workspace);
      return { workspaceServerIds: ["opengeni"], workspaceDefaultServerIds: [] };
    },
    workspaceSessionEffectiveToolsContext: async (
      _deps: unknown,
      _id: string,
      _subject: string,
      _sessions: unknown[],
      read: Promise<unknown>,
    ) => {
      reads.push(read);
      expect(await read).toBe(workspace);
      return { marker: "effective" };
    },
  };
  const load = loader(ports);
  expect(await load({ db: {}, settings: {} }, "workspace", "subject", [])).toEqual({
    workspaceServerIds: ["opengeni"],
    workspaceDefaultServerIds: [],
    effectiveToolsContext: { marker: "effective" },
  });
  expect(reads[0]).toBe(reads[1]);
  await load({ db: {}, settings: {} }, "workspace", "subject", []);
  expect(count).toBe(2);
  expect(reads[0]).not.toBe(reads[2]);
  const effective = deferred<unknown>();
  const policyError = new Error("policy failure");
  let finished = false;
  const failed = loader({
    ...ports,
    workspaceSessionToolPolicyContext: async () => {
      throw policyError;
    },
    workspaceSessionEffectiveToolsContext: () => effective.promise,
  })({ db: {}, settings: {} }, "workspace", "subject", []).catch((error: unknown) => {
    finished = true;
    return error;
  });
  await flush();
  expect(finished).toBe(false);
  effective.reject(new Error("effective failure"));
  expect(await failed).toBe(policyError);
  const policy = deferred<unknown>();
  const effectiveError = new Error("effective failed first");
  finished = false;
  const effectiveFailed = loader({
    ...ports,
    workspaceSessionToolPolicyContext: () => policy.promise,
    workspaceSessionEffectiveToolsContext: async () => {
      throw effectiveError;
    },
  })({ db: {}, settings: {} }, "workspace", "subject", []).catch((error: unknown) => {
    finished = true;
    return error;
  });
  await flush();
  expect(finished).toBe(false);
  policy.reject(new Error("policy failed later"));
  expect(await effectiveFailed).toBe(effectiveError);
});

test("GET diagnostics preserve context, work errors and nonblocking observer failures", async () => {
  const o = observer();
  const value = { privateContent: "never exported" };
  expect(
    await withTraceContext(parent, () =>
      measure(o, "session_read", async () => {
        expect(currentTraceContext()?.spanId).toBe("3".repeat(16));
        return value;
      }),
    ),
  ).toBe(value);
  const failure = new Error("private work error");
  for (const work of [
    () => {
      throw failure;
    },
    async () => {
      throw failure;
    },
  ]) {
    expect(await measure(o, "response_projection", work).catch((error: unknown) => error)).toBe(
      failure,
    );
  }
  const broken = {
    startSpan: () => {
      throw new Error("observer failure");
    },
  };
  expect(
    await withTraceContext(parent, () =>
      measure(broken, "authorization", async () => currentTraceContext()),
    ),
  ).toEqual(parent);
  const slow = { startSpan: () => ({ ...parent, end: () => new Promise<void>(() => {}) }) };
  expect(await measure(slow, "session_read", async () => value)).toBe(value);
  const rejected = {
    startSpan: () => ({ ...parent, end: () => Promise.reject(new Error("observer failure")) }),
  };
  expect(await measure(rejected, "session_read", async () => value)).toBe(value);
  expect(JSON.stringify(o.endings)).not.toContain("private");
});
