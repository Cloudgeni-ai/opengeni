import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { CLAUDE_CONNECTION_KINDS } from "@opengeni/config";

const source = readFileSync(new URL("../src/default-session-model.ts", import.meta.url), "utf8");
const parsed = parseSync("default-session-model.ts", source);
expect(parsed.errors).toEqual([]);
const declaration = parsed.program.body
  .map((node) => (node.type === "ExportNamedDeclaration" ? node.declaration : node))
  .find(
    (node) =>
      node?.type === "FunctionDeclaration" && node.id?.name === "loadWorkspaceModelSelectionInput",
  );
if (declaration?.type !== "FunctionDeclaration") throw new Error("Missing production loader");

const dependencies = [
  "connectionRestrictionsAndXaiReadiness",
  "loadWorkspaceClaudeSubscriptionReadiness",
  "getWorkspaceModelPolicy",
  "workspaceCodexSubscriptionActive",
  "loadWorkspaceCodexModelAvailability",
  "workspaceVercelAiGatewayConnectionActive",
  "listWorkspaceGatewayCustomModels",
  "workspaceOpenRouterConnectionActive",
  "listWorkspaceOpenRouterCustomModels",
  "organizationModelProviderConnectionActiveForWorkspace",
  "listOrganizationModelProviderCustomModelsForWorkspace",
  "getWorkspaceProviderApiKeyConnectionMetadata",
  "listWorkspaceProviderCustomModels",
];
// Execute the complete current production declaration, not a copied parallel
// recipe. The real helpers are replaced only at their existing read boundaries.
const productionLoader = new Function(
  "ports",
  new Bun.Transpiler({ loader: "ts" }).transformSync(`
    const { CLAUDE_CONNECTION_KINDS, ${dependencies.join(", ")} } = ports;
    const loader = ${source.slice(declaration.start, declaration.end)};
    return loader;
  `),
);

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};

function fixture(
  input: {
    subscription?: boolean;
    observe?: boolean | "default";
    syncFailure?: string;
    transaction?: boolean;
  } = {},
) {
  const db = input.transaction ? { rollback: () => undefined } : {};
  const settings = { claudeSubscriptionEnabled: input.subscription !== false };
  const context = {
    accountId: "account",
    workspaceId: "workspace",
    subjectId: "caller",
    xaiAuthoritySnapshot: { frozen: "xai" },
    claudeAuthoritySnapshot: { frozen: "claude" },
  };
  const values: Record<string, unknown> = {
    restrictions: { restrictions: { "supergrok/": ["allowed"] }, xaiSubscriptionActive: true },
    claude: { workspace: true, organization: false },
    policy: { allowedProviders: ["anthropic"], allowedModels: null },
    codex: true,
    observations: { marker: "availability" },
    gateway: true,
    gatewayModels: ["gateway-model"],
    openrouter: false,
    openrouterModels: ["openrouter-model"],
    "org-active:vercel_gateway": true,
    "org-active:openrouter": false,
    "org-models:vercel_gateway": ["org-gateway"],
    "org-models:openrouter": ["org-openrouter"],
    "org-active:anthropic": true,
    "org-models:anthropic": ["org-anthropic"],
    "org-models:claude_subscription": ["org-subscription"],
    "metadata:anthropic": { connectionId: "metadata-only", version: 4 },
    "workspace-models:anthropic": ["workspace-anthropic"],
    "workspace-models:claude_subscription": ["workspace-subscription"],
  };
  const holds = Object.fromEntries(Object.keys(values).map((name) => [name, deferred()]));
  const calls: { name: string; args: unknown[] }[] = [];
  const syncError = new Error("synchronous read failure");
  const read = (name: string, args: unknown[]) => {
    calls.push({ name, args });
    if (input.syncFailure === name) throw syncError;
    return holds[name]!.promise;
  };
  const ports = {
    CLAUDE_CONNECTION_KINDS,
    connectionRestrictionsAndXaiReadiness: (...args: unknown[]) => read("restrictions", args),
    loadWorkspaceClaudeSubscriptionReadiness: (...args: unknown[]) => read("claude", args),
    getWorkspaceModelPolicy: (...args: unknown[]) => read("policy", args),
    workspaceCodexSubscriptionActive: (...args: unknown[]) => read("codex", args),
    loadWorkspaceCodexModelAvailability: (...args: unknown[]) => read("observations", args),
    workspaceVercelAiGatewayConnectionActive: (...args: unknown[]) => read("gateway", args),
    listWorkspaceGatewayCustomModels: (...args: unknown[]) => read("gatewayModels", args),
    workspaceOpenRouterConnectionActive: (...args: unknown[]) => read("openrouter", args),
    listWorkspaceOpenRouterCustomModels: (...args: unknown[]) => read("openrouterModels", args),
    organizationModelProviderConnectionActiveForWorkspace: (database: unknown, scope: any) =>
      read(`org-active:${scope.providerKind}`, [database, scope]),
    listOrganizationModelProviderCustomModelsForWorkspace: (database: unknown, scope: any) =>
      read(`org-models:${scope.providerKind}`, [database, scope]),
    getWorkspaceProviderApiKeyConnectionMetadata: (
      database: unknown,
      workspaceId: string,
      kind: string,
    ) => read(`metadata:${kind}`, [database, workspaceId, kind]),
    listWorkspaceProviderCustomModels: (database: unknown, scope: any) =>
      read(`workspace-models:${scope.providerKind}`, [database, scope]),
  };
  const running = productionLoader(ports)(
    db,
    settings,
    context,
    input.observe === "default" ? undefined : { observeAvailability: input.observe === true },
  ) as Promise<any>;
  void running.catch(() => undefined);
  let settled = false;
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return {
    db,
    settings,
    context,
    values,
    holds,
    calls,
    running,
    syncError,
    names: () => calls.map((call) => call.name),
    settled: () => settled,
    release(names: string[]) {
      for (const name of names) holds[name]!.resolve(values[name]);
    },
    async cleanup() {
      for (const [name, hold] of Object.entries(holds)) hold.resolve(values[name]);
      await running.catch(() => undefined);
    },
  };
}

const catalogReads = [
  "org-active:anthropic",
  "org-models:anthropic",
  "metadata:anthropic",
  "workspace-models:anthropic",
  "org-models:claude_subscription",
  "workspace-models:claude_subscription",
];

test("all independent catalog reads start while the policy/readiness batch is held", async () => {
  const f = fixture();
  try {
    await flush();
    for (const name of catalogReads) expect(f.names()).toContain(name);
    expect(f.settled()).toBe(false);
    expect(f.names()).not.toContain("observations");
    f.release(catalogReads);
    await flush();
    expect(f.settled()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

for (const first of ["inputs", "catalog"] as const) {
  test(`${first} completion alone cannot return an incomplete model admission input`, async () => {
    const f = fixture();
    try {
      await flush();
      const inputs = Object.keys(f.values).filter((name) => !catalogReads.includes(name));
      f.release(first === "inputs" ? inputs : catalogReads);
      await flush();
      expect(f.settled()).toBe(false);
      f.release(first === "inputs" ? catalogReads : inputs);
      const result = await f.running;
      expect(result).toEqual({
        settings: f.settings,
        policy: f.values.policy,
        connectionModelRestrictions: { "supergrok/": ["allowed"] },
        xaiSubscriptionActive: true,
        codexSubscriptionActive: true,
        observations: {},
        workspaceGatewayConnectionActive: true,
        workspaceGatewayCustomModels: f.values.gatewayModels,
        workspaceOpenRouterConnectionActive: false,
        workspaceOpenRouterCustomModels: f.values.openrouterModels,
        organizationGatewayConnectionActive: true,
        organizationOpenRouterConnectionActive: false,
        organizationGatewayCustomModels: f.values["org-models:vercel_gateway"],
        organizationOpenRouterCustomModels: f.values["org-models:openrouter"],
        claudeConnections: {
          anthropic: { active: true, models: ["org-anthropic"] },
          claude_subscription: { active: false, models: ["org-subscription"] },
        },
        workspaceClaudeConnections: {
          anthropic: { active: true, models: ["workspace-anthropic"] },
          claude_subscription: { active: true, models: ["workspace-subscription"] },
        },
      });
    } finally {
      await f.cleanup();
    }
  });
}

test("subscription activation waits for the same exact fresh/frozen-subject readiness read", async () => {
  const f = fixture();
  try {
    await flush();
    f.release(Object.keys(f.values).filter((name) => name !== "claude"));
    await flush();
    expect(f.settled()).toBe(false);
    const read = f.calls.filter((call) => call.name === "claude");
    expect(read).toEqual([{ name: "claude", args: [f.db, f.settings, f.context] }]);
    f.holds.claude!.resolve({ workspace: false, organization: true });
    const result = await f.running;
    expect(result.claudeConnections.claude_subscription.active).toBe(true);
    expect(result.workspaceClaudeConnections.claude_subscription.active).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("disabled subscription skips only its catalog; every existing read keeps its exact scope and call count", async () => {
  const f = fixture({ subscription: false });
  try {
    await flush();
    expect(f.names()).not.toContain("org-models:claude_subscription");
    expect(f.names()).not.toContain("workspace-models:claude_subscription");
    expect(f.names()).not.toContain("org-active:claude_subscription");
    expect(f.names()).not.toContain("metadata:claude_subscription");
    expect(new Set(f.names()).size).toBe(f.names().length);
    for (const { name, args } of f.calls) {
      expect(args[0]).toBe(f.db);
      if (name.startsWith("org-") || name.startsWith("workspace-models:"))
        expect(args[1]).toEqual({
          accountId: f.context.accountId,
          workspaceId: f.context.workspaceId,
          providerKind: name.split(":")[1],
        });
      else if (name === "metadata:anthropic")
        expect(args.slice(1)).toEqual([f.context.workspaceId, "anthropic"]);
      else if (name === "restrictions" || name === "claude")
        expect(args.slice(1)).toEqual([f.settings, f.context]);
      else if (name === "codex") expect(args.slice(1)).toEqual([f.settings, f.context.workspaceId]);
      else if (name.endsWith("Models"))
        expect(args[1]).toEqual({
          accountId: f.context.accountId,
          workspaceId: f.context.workspaceId,
        });
      else expect(args.slice(1)).toEqual([f.context.workspaceId]);
    }
    f.release(Object.keys(f.values));
    const result = await f.running;
    expect(result.claudeConnections).not.toHaveProperty("claude_subscription");
    expect(result.workspaceClaudeConnections).not.toHaveProperty("claude_subscription");
  } finally {
    await f.cleanup();
  }
});

test("opt-in live availability is still invoked exactly once, never added to stable create admission", async () => {
  const f = fixture({ observe: true });
  try {
    await flush();
    expect(f.calls.filter((call) => call.name === "observations")).toEqual([
      { name: "observations", args: [f.db, f.settings, f.context.workspaceId] },
    ]);
    f.release(Object.keys(f.values));
    expect((await f.running).observations).toBe(f.values.observations);
  } finally {
    await f.cleanup();
  }
});

test("the loader's existing omitted-options default still observes live availability once", async () => {
  const f = fixture({ observe: "default" });
  try {
    await flush();
    expect(f.names().filter((name) => name === "observations")).toHaveLength(1);
    f.release(Object.keys(f.values));
    expect((await f.running).observations).toBe(f.values.observations);
  } finally {
    await f.cleanup();
  }
});

test("transaction handles retain the serial catalog boundary, with no new concurrent savepoints", async () => {
  const f = fixture({ transaction: true });
  try {
    await flush();
    for (const name of catalogReads) expect(f.names()).not.toContain(name);
    f.release(Object.keys(f.values).filter((name) => !catalogReads.includes(name)));
    await flush();
    for (const name of catalogReads) expect(f.names()).toContain(name);
    expect(f.settled()).toBe(false);
    f.release(catalogReads);
    await f.running;
  } finally {
    await f.cleanup();
  }
});

test("a refused transaction input batch never starts catalog reads", async () => {
  const f = fixture({ transaction: true });
  const error = new Error("transaction input refusal");
  try {
    f.holds.policy!.reject(error);
    await expect(f.running).rejects.toBe(error);
    for (const name of catalogReads) expect(f.names()).not.toContain(name);
  } finally {
    await f.cleanup();
  }
});

for (const failure of ["policy", "org-models:anthropic"] as const) {
  test(`${failure} failure waits for the other read wave and prevents downstream admission`, async () => {
    const f = fixture();
    const error = new Error(failure);
    let admitted = false;
    const admission = f.running.then(() => {
      admitted = true;
    });
    void admission.catch(() => undefined);
    try {
      await flush();
      f.holds[failure]!.reject(error);
      await flush();
      expect(f.settled()).toBe(false);
      expect(admitted).toBe(false);
      f.release(Object.keys(f.values));
      await expect(f.running).rejects.toBe(error);
      await admission.catch(() => undefined);
      expect(admitted).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
}

for (const first of ["policy", "org-models:anthropic"] as const) {
  test(`dual failure retains original input-wave priority when ${first} rejects first`, async () => {
    const f = fixture();
    const errors = { policy: new Error("policy"), "org-models:anthropic": new Error("catalog") };
    try {
      await flush();
      f.holds[first]!.reject(errors[first]);
      await flush();
      expect(f.settled()).toBe(false);
      const second = first === "policy" ? "org-models:anthropic" : "policy";
      f.holds[second]!.reject(errors[second]);
      await expect(f.running).rejects.toBe(errors.policy);
    } finally {
      await f.cleanup();
    }
  });
}

for (const failure of ["policy", "org-models:anthropic"] as const) {
  test(`synchronous ${failure} refusal cannot escape the other wave join`, async () => {
    const f = fixture({ syncFailure: failure });
    try {
      await flush();
      expect(f.settled()).toBe(false);
      f.release(Object.keys(f.values));
      await expect(f.running).rejects.toBe(f.syncError);
    } finally {
      await f.cleanup();
    }
  });
}
