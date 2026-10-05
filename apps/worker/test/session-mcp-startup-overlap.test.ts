import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { testSettings } from "@opengeni/testing";

type Policies = Record<string, "always" | "never">;
type Server = {
  id: string;
  url: string;
  requireApproval: "always" | "never";
  headers: Record<string, string>;
};
type Ports = {
  environmentsEncryptionKeyBytes: () => Uint8Array | null;
  getSessionAttemptMcpApprovalPolicies: (...args: unknown[]) => Promise<Policies>;
  listSessionMcpServerMetadata: (...args: unknown[]) => Promise<Array<{ headerNames: string[] }>>;
  listSessionMcpServersForRun: (...args: unknown[]) => Promise<Server[]>;
};

const source = readFileSync(new URL("../src/activities/capabilities.ts", import.meta.url), "utf8");
const parsed = parseSync("capabilities.ts", source);
if (parsed.errors.length) throw new Error("Invalid production capabilities source");
const transpiler = new Bun.Transpiler({ loader: "ts" });

function productionFunction(name: string): string {
  const exported = parsed.program.body.find(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === name,
  );
  if (
    exported?.type !== "ExportNamedDeclaration" ||
    exported.declaration?.type !== "FunctionDeclaration"
  )
    throw new Error(`Missing production function ${name}`);
  return source.slice(exported.declaration.start, exported.declaration.end);
}

function loader(ports: Ports) {
  // Execute both complete production functions; no handwritten settings overlay.
  const code = transpiler.transformSync(
    `${productionFunction("settingsWithSessionMcpServers")}\n${productionFunction("settingsWithSessionMcpServersForRun")}`,
  );
  return new Function(
    "ports",
    `const { environmentsEncryptionKeyBytes, getSessionAttemptMcpApprovalPolicies,
      listSessionMcpServerMetadata, listSessionMcpServersForRun } = ports;
      ${code}
      return settingsWithSessionMcpServersForRun;`,
  )(ports) as (
    db: object,
    workspaceId: string,
    sessionId: string,
    attemptId: string,
    settings: ReturnType<typeof testSettings>,
    options?: { onResolvedServers?: (servers: readonly Server[]) => void },
  ) => Promise<ReturnType<typeof testSettings>>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A negative control may never start one reader; observe the test-owned hold.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function fixtures(key: Uint8Array | null = new Uint8Array(32)) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const servers: Server[] = [
    { id: "session", url: "https://session.invalid/mcp", requireApproval: "always", headers: {} },
  ];
  const policies: Policies = { deployment: "always", session: "always" };
  const settings = testSettings({
    mcpServers: [
      { id: "deployment", url: "https://deployment.invalid/mcp", requireApproval: "never" },
    ],
  });
  const db = {};
  const ports: Ports = {
    environmentsEncryptionKeyBytes: () => key,
    getSessionAttemptMcpApprovalPolicies: async (...args) => {
      calls.push({ name: "policy", args });
      return policies;
    },
    listSessionMcpServerMetadata: async (...args) => {
      calls.push({ name: "metadata", args });
      return [];
    },
    listSessionMcpServersForRun: async (...args) => {
      calls.push({ name: "servers", args });
      return servers;
    },
  };
  return { calls, servers, policies, settings, db, ports, key };
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("pooled session MCP startup reads", () => {
  test("starts both exact scoped reads before either settles, then joins before projection", async () => {
    const f = fixtures();
    const policy = deferred<Policies>();
    const servers = deferred<Server[]>();
    f.ports.getSessionAttemptMcpApprovalPolicies = (...args) => {
      f.calls.push({ name: "policy", args });
      return policy.promise;
    };
    f.ports.listSessionMcpServersForRun = (...args) => {
      f.calls.push({ name: "servers", args });
      return servers.promise;
    };
    let projected = false;
    let settled = false;
    const running = loader(f.ports)(f.db, "workspace", "session", "attempt", f.settings, {
      onResolvedServers: (value) => {
        expect(value).toBe(f.servers);
        projected = true;
      },
    });
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await tick();
      expect(f.calls.map((call) => call.name)).toEqual(["policy", "servers"]);
      expect(f.calls[0]?.args).toEqual([f.db, "workspace", "session", "attempt"]);
      expect(f.calls[1]?.args).toEqual([f.db, "workspace", "session", "attempt", f.key]);
      servers.resolve(f.servers);
      await tick();
      expect(settled).toBe(false);
      expect(projected).toBe(false);
    } finally {
      policy.resolve(f.policies);
      servers.resolve(f.servers);
    }
    const settings = await running;
    expect(projected).toBe(true);
    expect(settings.mcpServers.map((server) => [server.id, server.requireApproval])).toEqual([
      ["deployment", "always"],
      ["session", "always"],
    ]);
    expect(f.settings.mcpServers[0]?.requireApproval).toBe("never");
  });

  for (const rejected of ["policy", "servers"] as const) {
    test(`${rejected} rejection waits for the held sibling and never projects settings`, async () => {
      const f = fixtures();
      const policy = deferred<Policies>();
      const servers = deferred<Server[]>();
      const failure = new Error("dependency refusal");
      f.ports.getSessionAttemptMcpApprovalPolicies = () => policy.promise;
      f.ports.listSessionMcpServersForRun = () => servers.promise;
      let projected = false;
      let settled = false;
      const running = loader(f.ports)(f.db, "workspace", "session", "attempt", f.settings, {
        onResolvedServers: () => {
          projected = true;
        },
      });
      const outcome = running.then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      if (rejected === "policy") policy.reject(failure);
      else servers.reject(failure);
      try {
        await tick();
        expect(settled).toBe(false);
        expect(projected).toBe(false);
      } finally {
        policy.resolve(f.policies);
        servers.resolve(f.servers);
      }
      expect(await outcome).toEqual({ error: failure });
      expect(projected).toBe(false);
    });
  }

  test("preserves policy-error priority when both readers reject", async () => {
    const f = fixtures();
    const policyError = new Error("policy refusal");
    const serverError = new Error("credential refusal");
    f.ports.getSessionAttemptMcpApprovalPolicies = async () => {
      throw policyError;
    };
    f.ports.listSessionMcpServersForRun = async () => {
      throw serverError;
    };
    await expect(loader(f.ports)(f.db, "workspace", "session", "attempt", f.settings)).rejects.toBe(
      policyError,
    );
  });

  test("synchronous policy refusal is joined with an already-started credential read", async () => {
    const f = fixtures();
    const held = deferred<Server[]>();
    const failure = new Error("synchronous refusal");
    f.ports.getSessionAttemptMcpApprovalPolicies = () => {
      f.calls.push({ name: "policy", args: [] });
      throw failure;
    };
    f.ports.listSessionMcpServersForRun = () => {
      f.calls.push({ name: "servers", args: [] });
      return held.promise;
    };
    let settled = false;
    const outcome = loader(f.ports)(f.db, "workspace", "session", "attempt", f.settings).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await tick();
      expect(f.calls.map((call) => call.name)).toEqual(["policy", "servers"]);
      expect(settled).toBe(false);
    } finally {
      held.resolve(f.servers);
    }
    expect(await outcome).toBe(failure);
  });

  test("synchronous credential refusal is joined with a held policy read", async () => {
    const f = fixtures();
    const held = deferred<Policies>();
    const failure = new Error("synchronous credential refusal");
    f.ports.getSessionAttemptMcpApprovalPolicies = () => held.promise;
    f.ports.listSessionMcpServersForRun = () => {
      throw failure;
    };
    let settled = false;
    const outcome = loader(f.ports)(f.db, "workspace", "session", "attempt", f.settings).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await tick();
      expect(settled).toBe(false);
    } finally {
      held.resolve(f.policies);
    }
    expect(await outcome).toBe(failure);
  });

  test("transaction handles preserve serial reader ordering", async () => {
    const f = fixtures();
    const policy = deferred<Policies>();
    f.ports.getSessionAttemptMcpApprovalPolicies = (...args) => {
      f.calls.push({ name: "policy", args });
      return policy.promise;
    };
    const transaction = {
      rollback() {
        throw new Error("test must not rollback");
      },
    };
    const running = loader(f.ports)(transaction, "workspace", "session", "attempt", f.settings);
    await tick();
    expect(f.calls.map((call) => call.name)).toEqual(["policy"]);
    policy.resolve(f.policies);
    await running;
    expect(f.calls.map((call) => call.name)).toEqual(["policy", "servers"]);
  });

  test("missing-key metadata fallback remains serial and omits credential reads for an empty list", async () => {
    const f = fixtures(null);
    const result = await loader(f.ports)(f.db, "workspace", "session", "attempt", f.settings);
    expect(f.calls.map((call) => call.name)).toEqual(["policy", "metadata"]);
    expect(result.mcpServers[0]?.requireApproval).toBe("always");
  });

  test("missing-key credential metadata still fails before decryption or projection", async () => {
    const f = fixtures(null);
    f.ports.listSessionMcpServerMetadata = async () => [{ headerNames: ["Authorization"] }];
    await expect(
      loader(f.ports)(f.db, "workspace", "session", "attempt", f.settings),
    ).rejects.toThrow(
      "session MCP server credentials require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
    );
    expect(f.calls.map((call) => call.name)).toEqual(["policy"]);
  });

  test("missing-key public server rows still load after policy and metadata", async () => {
    const f = fixtures(null);
    f.ports.listSessionMcpServerMetadata = async (...args) => {
      f.calls.push({ name: "metadata", args });
      return [{ headerNames: [] }];
    };
    await loader(f.ports)(f.db, "workspace", "session", "attempt", f.settings);
    expect(f.calls.map((call) => call.name)).toEqual(["policy", "metadata", "servers"]);
    expect(f.calls[2]?.args).toEqual([f.db, "workspace", "session", "attempt", null]);
  });
});

test("the bounded timing child wraps only the existing MCP settings call", () => {
  const governanceSource = readFileSync(
    new URL("../src/activities/agent-turn/governance-model.ts", import.meta.url),
    "utf8",
  );
  const governance = parseSync("governance-model.ts", governanceSource);
  expect(governance.errors).toEqual([]);
  const exported = governance.program.body.find(
    (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === "prepareGovernanceAndModel",
  );
  if (
    exported?.type !== "ExportNamedDeclaration" ||
    exported.declaration?.type !== "FunctionDeclaration"
  )
    throw new Error("Missing production governance function");
  const declaration = exported.declaration.body?.body
    .flatMap((node) => (node.type === "VariableDeclaration" ? node.declarations : []))
    .find((node) => node.id.type === "Identifier" && node.id.name === "runSettings");
  const init = declaration?.init;
  if (init?.type !== "AwaitExpression" || init.argument.type !== "CallExpression") {
    throw new Error("MCP settings must remain one awaited dependency");
  }
  const call = init.argument;
  expect(call.callee).toMatchObject({ type: "Identifier", name: "measureTurnStartupPhase" });
  expect(call.arguments[0]).toMatchObject({ type: "Identifier", name: "observability" });
  const labels = call.arguments[1];
  if (labels?.type !== "ObjectExpression") throw new Error("Missing bounded timing labels");
  expect(
    labels.properties.map((property) => governanceSource.slice(property.start, property.end)),
  ).toEqual([
    'phase: "session_mcp_settings"',
    "provider: turnExecutionPolicy.providerId",
    "backend: turn.sandboxBackend",
  ]);
  const work = call.arguments[2];
  if (work?.type !== "ArrowFunctionExpression" || work.body.type !== "CallExpression") {
    throw new Error("Timing must wrap only the existing read helper");
  }
  expect(work.body.callee).toMatchObject({
    type: "Identifier",
    name: "settingsWithSessionMcpServersForRun",
  });
  expect(
    work.body.arguments.map((argument) => governanceSource.slice(argument.start, argument.end)),
  ).toEqual(["db", "input.workspaceId", "input.sessionId", "input.attemptId", "baseRunSettings"]);
});
