import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { createDb, createWorkspace, createOrganizationApiKey, type DbClient } from "@opengeni/db";
import type { TranscriptionAvailabilityContext } from "@opengeni/core";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { createTranscriptionService } from "@opengeni/core/transcription-service";

let shared: SharedTestDatabase;
let client: DbClient;
const settings = testSettings({
  productAccessMode: "managed",
  sandboxBackend: "none",
  codexSubscriptionEnabled: true,
  supergrokSubscriptionEnabled: true,
  voiceInputProviderOrder: "codex-subscription,supergrok-subscription",
});
const noFetch = Object.assign(
  async () => {
    throw new Error("No provider request permitted");
  },
  {
    preconnect: () => {
      throw new Error("No provider preconnect permitted");
    },
  },
);

beforeAll(async () => {
  const database = await acquireSharedTestDatabase("transcription-readiness-scope");
  if (!database) throw new Error("Real PostgreSQL required");
  shared = database;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function fixture() {
  const [account] = await shared.admin`
    insert into managed_accounts(name) values ('Voice scope fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(client.db, { accountId, name: "Voice scope" });
  const context = { accountId, workspaceId: workspace.id, subjectId: "user:voice-scope" };
  const fallback = { workspaceId: workspace.id, subjectId: context.subjectId };
  const service = createTranscriptionService({
    db: client.db,
    settings,
    fetch: noFetch,
    codexFetch: noFetch,
  });
  const ids = (scope: TranscriptionAvailabilityContext) => service.availableProviderIds!(scope);
  return { context, fallback, service, ids };
}

// Raw fixtures represent already-connected shared accounts. These readiness
// tests never decrypt a credential, send audio or call a provider.
async function connect(context: { accountId: string; workspaceId: string }) {
  for (const provider of ["codex", "xai"]) {
    await shared.admin`
      insert into subscription_provider_cutovers(account_id, provider, enabled)
      values (${context.accountId}::uuid, ${provider}, true)
      on conflict (account_id, provider) do update set enabled = true`;
    const [connection] = await shared.admin`
      insert into subscription_connections (
        account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        provider_account_id, plan_type, provider_state, expires_at, label
      ) values (
        ${context.accountId}::uuid, ${provider}, 'subscription', 'not-decrypted',
        'shared', 'organization', ${crypto.randomUUID()}, 'pro', '{}'::jsonb,
        now() + interval '1 day', 'Readiness fixture'
      ) returning id`;
    await shared.admin`
      insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool
      ) values (${context.accountId}::uuid, ${String(connection!.id)}::uuid,
        ${context.workspaceId}::uuid, 'organization')`;
  }
}

test("supplied scope preserves fresh empty, active, revoked and maintenance results", async () => {
  const f = await fixture();
  const check = async (expected: string[]) => {
    expect(await f.ids(f.context)).toEqual(expected);
    expect(await f.ids(f.fallback)).toEqual(expected);
  };
  await check([]);
  await connect(f.context);
  await check(["codex-subscription", "supergrok-subscription"]);
  await shared.admin`update subscription_connections set status = 'needs_relogin'
    where account_id = ${f.context.accountId}::uuid`;
  await check([]);
  await shared.admin`update subscription_connections set status = 'active'
    where account_id = ${f.context.accountId}::uuid`;
  await check(["codex-subscription", "supergrok-subscription"]);
  await shared.admin`update subscription_provider_cutovers set enabled = false
    where account_id = ${f.context.accountId}::uuid`;
  await check([]);
});

test("supplied account cannot expose another account's pool or a deleted workspace", async () => {
  const own = await fixture();
  const foreign = await fixture();
  await connect(foreign.context);
  expect(await own.ids({ ...own.context, accountId: foreign.context.accountId })).toEqual([]);
  expect(await own.ids({ ...foreign.context, accountId: own.context.accountId })).toEqual([]);
  expect(await foreign.ids(foreign.context)).toHaveLength(2);
  await shared.admin`delete from workspaces where id = ${foreign.context.workspaceId}::uuid`;
  expect(await foreign.ids(foreign.context)).toEqual([]);
  expect(await foreign.ids(foreign.fallback)).toEqual([]);
});

test("account hint removes only workspace hydration, not fresh provider queries", async () => {
  const f = await fixture();
  await connect(f.context);
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const previous = driver.options.debug;
  let statements: string[] = [];
  driver.options.debug = (_connection, query) => {
    // A new pooled connection first reads array types; that is not a readiness query.
    if (!query.includes("pg_catalog.pg_type")) statements.push(query.replace(/\s+/g, " "));
  };
  try {
    const oldIds = await f.ids(f.fallback);
    const fallbackQueries = statements;
    statements = [];
    const newIds = await f.ids(f.context);
    const scopedQueries = statements;
    expect(newIds).toEqual(oldIds);
    // Codex, Grok and the workspace-key provider each hydrate the workspace
    // once, and so does the EU-only check (one read shared by every provider).
    expect(fallbackQueries.length - scopedQueries.length).toBe(24);
    expect(scopedQueries.some((q) => q.includes('"workspace_inference_controls"'))).toBe(false);
    for (const queries of [fallbackQueries, scopedQueries]) {
      expect(
        queries.filter((q) => q.includes("select enabled from subscription_provider_cutovers")),
      ).toHaveLength(3);
      expect(queries.filter((q) => q.includes("select connection.id::text"))).toHaveLength(4);
      // Both find an organization's key, whether or not the caller named the account.
      expect(
        queries.filter((q) => q.includes('from "organization_model_provider_connections"')),
      ).toHaveLength(1);
    }
  } finally {
    driver.options.debug = previous;
  }
});

test.skipIf(process.env.OPENGENI_BENCH_VOICE_READINESS !== "1")(
  "paired config requests preserve bytes while eliminating repeated hydration",
  async () => {
    const f = await fixture();
    const token = crypto.randomUUID();
    await createOrganizationApiKey(client.db, {
      accountId: f.context.accountId,
      name: "Voice benchmark",
      prefix: "fixture",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["workspace:admin"],
    });
    const withoutAccount = (context: TranscriptionAvailabilityContext = {}) => {
      const { accountId: _account, ...rest } = context;
      return rest;
    };
    const makeApp = (legacy: boolean) =>
      createApp({
        db: client.db,
        bus: new MemoryEventBus(),
        managedAuth: null,
        settings,
        workflowClient: {} as never,
        transcription: legacy
          ? {
              ...f.service,
              availableProviderIds: (context) =>
                f.service.availableProviderIds!(withoutAccount(context)),
              available: (context) => f.service.available(withoutAccount(context)),
            }
          : f.service,
      });
    // Removing the new optional hint exercises the unchanged legacy fallback.
    // Both routes otherwise execute the same current HTTP/auth/catalog path.
    const apps = { baseline: makeApp(true), candidate: makeApp(false) };
    const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
    const previous = driver.options.debug;
    let queries: string[] = [];
    driver.options.debug = (_connection, query) => {
      queries.push(query);
    };
    try {
      for (const mode of ["organization", "external"] as const) {
        const headers = {
          authorization: `Bearer ${token}`,
          ...(mode === "external"
            ? {
                "x-opengeni-external-actor": encodeURIComponent(
                  JSON.stringify({
                    mode: "external",
                    identity: { source: "fixture", externalId: "voice-reader" },
                  }),
                ),
              }
            : {}),
        };
        const samples: Record<
          string,
          Array<{ milliseconds: number; statements: number; transactions: number }>
        > = {
          baseline: [],
          candidate: [],
        };
        for (let pair = -5; pair < 20; pair++) {
          let expected: string | undefined;
          for (const variant of (pair % 2 === 0
            ? ["baseline", "candidate"]
            : ["candidate", "baseline"]) as Array<keyof typeof apps>) {
            queries = [];
            const start = performance.now();
            const response = await apps[variant].request(
              `/v1/config/client?workspaceId=${f.context.workspaceId}`,
              { headers },
            );
            const body = await response.text();
            expect(response.status).toBe(200);
            if (expected === undefined) expected = body;
            else expect(body).toBe(expected);
            if (pair >= 0)
              samples[variant]!.push({
                milliseconds: performance.now() - start,
                statements: queries.length,
                transactions: queries.filter((q) => q.trim().startsWith("begin")).length,
              });
          }
        }
        const summarize = (values: typeof samples.baseline) =>
          Object.fromEntries(
            (["milliseconds", "statements", "transactions"] as const).map((key) => [
              key,
              values!.map((value) => value[key]).sort((a, b) => a - b)[10],
            ]),
          );
        expect(samples.baseline![0]!.statements - samples.candidate![0]!.statements).toBe(12);
        expect(samples.baseline![0]!.transactions - samples.candidate![0]!.transactions).toBe(2);
        console.log(
          JSON.stringify({
            mode,
            equalPairs: 25,
            measuredPairs: 20,
            baseline: summarize(samples.baseline),
            candidate: summarize(samples.candidate),
          }),
        );
      }
    } finally {
      driver.options.debug = previous;
    }
  },
  30_000,
);

test("config supplies the verified grant account, not a query-supplied account", async () => {
  const f = await fixture();
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId: f.context.accountId,
    name: "Voice fixture",
    prefix: "fixture",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:admin"],
  });
  const observed: TranscriptionAvailabilityContext[] = [];
  const app = createApp({
    db: client.db,
    bus: new MemoryEventBus(),
    managedAuth: null,
    settings,
    workflowClient: {} as never,
    transcription: {
      ...f.service,
      availableProviderIds: async (context) => {
        observed.push(context);
        return [];
      },
    },
  });
  const response = await app.request(
    `/v1/config/client?workspaceId=${f.context.workspaceId}&accountId=${crypto.randomUUID()}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(observed).toHaveLength(1);
  expect(observed[0]?.accountId).toBe(f.context.accountId);
  expect(observed[0]?.workspaceId).toBe(f.context.workspaceId);
});
