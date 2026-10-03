import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { currentTraceContext, withTraceContext, type Span } from "@opengeni/observability";
import { measureSessionCreatePhase } from "../src/session-create-observability";
import {
  sessionCreationMetadata,
  withSiteSessionOrigin,
} from "../../../packages/core/src/site-session-origin";

const parent = { traceId: "1".repeat(32), spanId: "2".repeat(16) };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function observer(end?: Span["end"]) {
  const names: string[] = [];
  const endings: unknown[] = [];
  return {
    names,
    endings,
    startSpan(name: string): Span {
      names.push(name);
      return {
        ...parent,
        spanId: "3".repeat(16),
        end:
          end ??
          ((input) => {
            endings.push(input);
          }),
      };
    },
  };
}

function productionRoute() {
  const source = readFileSync(new URL("../src/routes/sessions.ts", import.meta.url), "utf8");
  const parsed = parseSync("sessions.ts", source);
  expect(parsed.errors).toEqual([]);
  let handler: any;
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "MemberExpression" &&
      node.callee.object?.name === "app" &&
      node.callee.property?.name === "post" &&
      node.arguments[0]?.value === "/v1/workspaces/:workspaceId/sessions"
    )
      handler = node.arguments[1];
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(parsed.program);
  if (!handler) throw new Error("Missing production create route");
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `const handler = ${source.slice(handler.start, handler.end)};`,
  );
  return new Function(
    "ports",
    "deps",
    "db",
    `
    const { requireAccessGrantAuthorization, CreateSessionRequest, resolveSiteSessionOrigin,
      withSiteSessionOrigin, createSessionForRequest, sessionCreateErrorResponse,
      withEffectivePolicy, measureSessionCreatePhase } = ports;
    ${code}
    return handler;
  `,
  ) as (ports: object, deps: object, db: object) => (c: object) => Promise<any>;
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function routeFixture() {
  const hold = {
    authorization: deferred<any>(),
    create: deferred<any>(),
    projection: deferred<any>(),
  };
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const o = observer();
  const deps = { observability: o };
  const db = {};
  const payload = { initialMessage: "private prompt", model: "private-model" };
  const authorization = { grant: { subjectId: "private-subject" } };
  const c = {
    req: {
      param: () => "workspace",
      header: () => undefined,
      json: async () => {
        calls.push({ name: "body", args: [] });
        return payload;
      },
    },
    json: (body: unknown, status: number) => ({ body, status }),
  };
  const ports = {
    measureSessionCreatePhase,
    requireAccessGrantAuthorization: (...args: unknown[]) => {
      calls.push({ name: "authorization", args });
      return hold.authorization.promise;
    },
    CreateSessionRequest: {
      parse: (value: unknown) => {
        calls.push({ name: "validation", args: [value] });
        return value;
      },
    },
    resolveSiteSessionOrigin: async (...args: unknown[]) => {
      calls.push({ name: "site", args });
      return null;
    },
    withSiteSessionOrigin: () => {
      throw new Error("Unexpected Site scope");
    },
    createSessionForRequest: (...args: unknown[]) => {
      calls.push({ name: "create", args });
      return hold.create.promise;
    },
    sessionCreateErrorResponse: (_c: unknown, error: unknown) => ({ createError: error }),
    withEffectivePolicy: (...args: unknown[]) => {
      calls.push({ name: "projection", args });
      return hold.projection.promise;
    },
  };
  return {
    hold,
    calls,
    o,
    deps,
    db,
    payload,
    authorization,
    c,
    ports,
    run: () => productionRoute()(ports, deps, db)(c),
  };
}

test("exact production route retains authorization, create and post-commit projection order", async () => {
  const f = routeFixture();
  const session = { id: "session" };
  const projected = { ...session, policy: "private-policy" };
  const running = f.run();
  try {
    expect(f.calls.map((c) => c.name)).toEqual(["authorization"]);
    expect(f.calls[0]!.args).toEqual([f.c, f.deps, "workspace", "sessions:create"]);
    f.hold.authorization.resolve(f.authorization);
    await flush();
    expect(f.calls.map((c) => c.name)).toEqual([
      "authorization",
      "body",
      "validation",
      "site",
      "create",
    ]);
    expect(f.calls.at(-1)!.args).toEqual([
      f.deps,
      f.authorization.grant,
      "workspace",
      f.payload,
      f.authorization,
    ]);
    f.hold.create.resolve(session);
    await flush();
    expect(f.calls.at(-1)).toEqual({
      name: "projection",
      args: [f.deps, "workspace", "private-subject", session],
    });
    f.hold.projection.resolve(projected);
    expect(await running).toEqual({ body: projected, status: 202 });
    expect(f.o.names).toEqual([
      "api.session_create.authorization",
      "api.session_create.body_read",
      "api.session_create.site_origin",
      "api.session_create.core_create",
      "api.session_create.response_projection",
    ]);
    expect(JSON.stringify(f.o.endings)).not.toContain("private-");
  } finally {
    f.hold.authorization.resolve(f.authorization);
    f.hold.create.resolve(session);
    f.hold.projection.resolve(projected);
    await running.catch(() => undefined);
  }
});

test("authorization refusal cannot read body, select Site, create or project", async () => {
  const f = routeFixture();
  const failure = new Error("private authorization");
  const running = f.run();
  f.hold.authorization.reject(failure);
  await expect(running).rejects.toBe(failure);
  expect(f.calls.map((c) => c.name)).toEqual(["authorization"]);
  expect(f.o.endings).toEqual([{ attributes: { outcome: "failed" } }]);
});

test("the production Site branch retains request-local provenance without exporting it", async () => {
  const f = routeFixture();
  const origin = { siteId: "private-site", title: "private title" };
  const session = { id: "session" };
  let metadata: unknown;
  const ports = {
    ...f.ports,
    resolveSiteSessionOrigin: async () => origin,
    withSiteSessionOrigin,
    createSessionForRequest: async () => {
      await Promise.resolve();
      metadata = sessionCreationMetadata({});
      return session;
    },
  };
  const running = productionRoute()(ports, f.deps, f.db)(f.c);
  f.hold.authorization.resolve(f.authorization);
  f.hold.projection.resolve(session);
  expect(await running).toEqual({ body: session, status: 202 });
  expect(metadata).toEqual({ _opengeniSiteOrigin: origin });
  expect(sessionCreationMetadata({})).toEqual({});
  expect(JSON.stringify(f.o.endings)).not.toContain("private");
});

test("create failure remains in the rejection envelope, projection failure remains outside it", async () => {
  for (const phase of ["create", "projection"] as const) {
    const f = routeFixture();
    const failure = new Error(`private ${phase}`);
    const running = f.run();
    f.hold.authorization.resolve(f.authorization);
    await flush();
    if (phase === "create") {
      f.hold.create.reject(failure);
      expect(await running).toEqual({ createError: failure });
      expect(f.calls.some((c) => c.name === "projection")).toBe(false);
    } else {
      f.hold.create.resolve({ id: "committed" });
      await flush();
      f.hold.projection.reject(failure);
      await expect(running).rejects.toBe(failure);
    }
  }
});

test("malformed JSON retains 422 before validation and storage", async () => {
  const f = routeFixture();
  f.c.req.json = async () => {
    throw new Error("private bad JSON");
  };
  const running = f.run();
  f.hold.authorization.resolve(f.authorization);
  expect(await running).toEqual({
    status: 422,
    body: {
      code: "INVALID_SESSION_CREATE_REQUEST",
      message: "Invalid session create request: request body must contain valid JSON",
    },
  });
  expect(f.calls.map((c) => c.name)).toEqual(["authorization"]);
  expect(f.o.names).toEqual(["api.session_create.authorization", "api.session_create.body_read"]);
});

test("observer errors and unending exporters cannot change values, exact errors or parent scope", async () => {
  const failure = new Error("private original");
  const value = { private: "response" };
  const broken = {
    startSpan: () => {
      throw new Error("observer");
    },
  };
  for (const o of [
    undefined,
    broken,
    observer(() => {
      throw new Error("export");
    }),
    observer(async () => {
      throw new Error("async export");
    }),
    observer(() => new Promise<void>(() => undefined)),
  ]) {
    expect(
      await withTraceContext(parent, () =>
        measureSessionCreatePhase(o, "authorization", async () => value),
      ),
    ).toBe(value);
    await expect(
      measureSessionCreatePhase(o, "core_create", () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  }
  expect(
    await withTraceContext(parent, () =>
      measureSessionCreatePhase(broken, "site_origin", async () => currentTraceContext()),
    ),
  ).toEqual(parent);
});

test("held route diagnostics end only with work and keep concurrent child scopes isolated", async () => {
  const hold = deferred<void>();
  const slow = observer();
  const fast = observer();
  fast.startSpan = (name: string) => {
    fast.names.push(name);
    return {
      ...parent,
      spanId: "4".repeat(16),
      end: (input) => {
        fast.endings.push(input);
      },
    };
  };
  const running = measureSessionCreatePhase(slow, "core_create", async () => {
    await hold.promise;
    return currentTraceContext()?.spanId;
  });
  try {
    expect(slow.endings).toEqual([]);
    expect(
      await measureSessionCreatePhase(
        fast,
        "response_projection",
        async () => currentTraceContext()?.spanId,
      ),
    ).toBe("4".repeat(16));
    expect(currentTraceContext()).toBeUndefined();
  } finally {
    hold.resolve();
  }
  expect(await running).toBe("3".repeat(16));
  expect(slow.endings).toEqual([{ attributes: { outcome: "completed" } }]);
});
