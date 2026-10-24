import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  createOrganizationApiKey,
  createWorkspaceProviderCustomModel,
  workspaceProviderApiKeyConnectionSpec,
} from "@opengeni/db";
import { createApp, type AppDependencies } from "../../apps/api/src/app";

// Actual in-process HTTP routing/auth/DB/serialization, not ingress latency.
// Exact-base route and app modules use the same installed dependencies and DB.
async function baselineApp(ref: string): Promise<typeof createApp> {
  const moduleUrl = (path: string, overrides: Record<string, string> = {}) => {
    const source = Bun.spawnSync(["git", "show", `${ref}:${path}`]);
    if (source.exitCode !== 0) throw Error(`Cannot read ${path} at benchmark base`);
    let code = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
      source.stdout.toString(),
    );
    const origin = new URL(`../../${path}`, import.meta.url);
    for (const match of [...code.matchAll(/from "([^"]+)"/g)]) {
      const spec = match[1]!;
      const target = overrides[spec] ?? Bun.resolveSync(spec, fileURLToPath(new URL(".", origin)));
      code = code.replaceAll(JSON.stringify(spec), JSON.stringify(target));
    }
    return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  };
  const routes = moduleUrl("apps/api/src/routes/workspaces.ts");
  return (await import(moduleUrl("apps/api/src/app.ts", { "./routes/workspaces": routes })))
    .createApp;
}

const baseRef = process.env.BENCH_BASE_REF;
if (!baseRef) throw Error("Set BENCH_BASE_REF to the exact pre-change Git revision");
const oldCreateApp = await baselineApp(baseRef);
const shared = await acquireSharedTestDatabase("bench-http-model-catalog");
if (!shared) throw Error("A disposable real PostgreSQL fixture is required");
const client = createDb(shared.appUrl, { max: 10 });
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
let queries: string[] | undefined;
driver.options.debug = (_id, query) => queries?.push(query);
const previousFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => {
    throw Error("External requests are forbidden in this offline benchmark");
  },
  {
    preconnect: () => {
      throw Error("External preconnects are forbidden in this offline benchmark");
    },
  },
);
try {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "benchmark",
    accountExternalId: crypto.randomUUID(),
    accountName: "Catalog benchmark",
    workspaceExternalSource: "benchmark",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Catalog benchmark",
    subjectId: "user:catalog-benchmark",
  });
  const grant = access.workspaceGrants[0]!;
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Offline fixture",
    prefix: "fixture",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:admin", "workspace:create", "members:manage", "api_keys:manage"],
  });
  const deps: AppDependencies = {
    db: client.db,
    bus: new MemoryEventBus(),
    managedAuth: null,
    settings: testSettings({
      productAccessMode: "managed",
      sandboxBackend: "none",
      codexSubscriptionEnabled: false,
      claudeSubscriptionEnabled: false,
    }),
    workflowClient: {} as never,
  };
  const apps = { base: oldCreateApp(deps), candidate: createApp(deps) };
  const callers: Record<string, Record<string, string>> = {
    organization: { authorization: `Bearer ${token}` },
    external: {
      authorization: `Bearer ${token}`,
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({
          mode: "external",
          identity: { source: "benchmark", externalId: "viewer" },
        }),
      ),
    },
  };
  for (const populated of [false, true]) {
    if (populated) {
      for (const providerKind of ["vercel_gateway", "openrouter", "opper"] as const) {
        const spec = workspaceProviderApiKeyConnectionSpec(providerKind);
        await createConnection(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId: null,
          providerDomain: spec.providerDomain,
          kind: "api_key",
          credentialEncrypted: "offline-fixture-not-decrypted",
          metadata: { credentialRole: spec.credentialRole },
          createdBySubjectId: grant.subjectId,
        });
        for (let i = 0; i < 10; i++) {
          await createWorkspaceProviderCustomModel(client.db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            providerKind,
            upstreamModelId: `fixture/model-${i}`,
            operationId: crypto.randomUUID(),
            requestHash: "a".repeat(64),
            createdBySubjectId: grant.subjectId,
          });
        }
      }
    }
    for (const [caller, headers] of Object.entries(callers)) {
      const samples = { base: [] as number[][], candidate: [] as number[][] };
      for (let pair = -5; pair < 40; pair++) {
        let expected: string | undefined;
        const order =
          pair % 2 === 0 ? (["base", "candidate"] as const) : (["candidate", "base"] as const);
        for (const variant of order) {
          queries = [];
          const start = performance.now();
          const cpu = process.cpuUsage();
          const response = await apps[variant].request(
            `/v1/workspaces/${grant.workspaceId}/model-catalog`,
            { headers },
          );
          const body = await response.text();
          const elapsed = performance.now() - start;
          const used = process.cpuUsage(cpu);
          assert.equal(response.status, 200, body);
          if (expected !== undefined) assert.equal(body, expected);
          else expected = body;
          if (pair >= 0)
            samples[variant].push([
              elapsed,
              (used.user + used.system) / 1000,
              queries.length,
              queries.filter((query) => query.trim().startsWith("begin")).length,
            ]);
          queries = undefined;
        }
      }
      const medians = Object.fromEntries(
        Object.entries(samples).map(([variant, rows]) => [
          variant,
          Object.fromEntries(
            ["elapsedMs", "cpuMs", "statements", "transactions"].map((name, i) => [
              name,
              rows.map((row) => row[i]!).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
            ]),
          ),
        ]),
      );
      console.log(
        JSON.stringify({ populated, caller, measuredPairs: 40, equalPairs: 45, medians }),
      );
    }
  }
} finally {
  globalThis.fetch = previousFetch;
  queries = undefined;
  await client.close();
  await shared.release();
}
