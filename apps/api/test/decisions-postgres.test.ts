import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createDb,
  createWorkspace,
  createOrganizationApiKey,
  setWorkspaceAllowance,
  checkWorkspaceAllowance,
  listUsageEvents,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createAppComposition } from "../src/app";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const closers: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("public-decisions");
  if (!acquired) throw new Error("Public decision verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  for (const close of closers.reverse()) await close();
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts(name) values ('Decision fixture') returning id`;
  const accountId = String(account!.id);
  const platform = await createWorkspace(client.db, { accountId, name: "Platform" });
  const customer = await createWorkspace(client.db, { accountId, name: "Customer" });
  const personal = await createWorkspace(client.db, { accountId, name: "Owner" });
  await shared.admin`insert into organization_memberships (account_id,subject_id,role,status,personal_workspace_id) values (${accountId}::uuid,'fixture','owner','active',${personal.id}::uuid)`;
  await setWorkspaceAllowance(client.db, {
    accountId,
    workspaceId: customer.id,
    actorSubjectId: "fixture",
    expectedVersion: 0,
    includedCredits: 0,
    period: "none",
    unbilledUsage: "list_price",
  });
  expect(
    await checkWorkspaceAllowance(client.db, { accountId, workspaceId: customer.id }),
  ).toMatchObject({ code: "allowance_exhausted" });
  const token = crypto.randomUUID();
  const key = await createOrganizationApiKey(client.db, {
    accountId,
    name: "Platform",
    prefix: "fixture",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:admin"],
  });
  const durations = new Map<string, number>();
  let requests = 0;
  let delayMs = 0;
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const started = performance.now();
      const body = (await request.json()) as {
        input?: string;
        messages?: Array<{ content: string }>;
      };
      const id = body.input ?? body.messages?.at(-1)?.content ?? "unknown";
      requests++;
      if (delayMs) await Bun.sleep(delayMs);
      const response = new URL(request.url).pathname.endsWith("/decisions")
        ? Response.json({
            answers: [{ name: "match", type: "predicate", probability: 0.9 }],
            usage: { input_tokens: 12, output_tokens: 3, cost: 0.004 },
          })
        : Response.json({
            id,
            object: "chat.completion",
            model: "local-chat",
            choices: [
              { index: 0, finish_reason: "stop", message: { role: "assistant", content: "yes" } },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
          });
      durations.set(id, performance.now() - started);
      return response;
    },
  });
  const settings = testSettings({
    productAccessMode: "managed",
    sandboxBackend: "none",
    usageAllowancesEnabled: true,
    voiceInputProviderOrder: "",
    decisionModelProvider: "openai",
    decisionModelId: "local-decision",
    decisionModelApiKey: "fixture-key",
    decisionModelBaseUrl: `${upstream.url.origin}/v1`,
    modelProvidersJson: JSON.stringify([
      {
        kind: "anonymous",
        id: "local",
        label: "Local test",
        api: "chat",
        baseUrl: `${upstream.url.origin}/v1`,
        models: [{ id: "local/chat", upstreamModelId: "local-chat", label: "Local chat" }],
      },
    ]),
    modelCostPolicyJson: JSON.stringify({ "local/chat": "free" }),
  });
  const composition = createAppComposition({
    db: client.db,
    settings,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    managedAuth: null,
    transcription: null,
  });
  const api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: composition.app.fetch });
  closers.push(async () => {
    await api.stop(true);
    await composition.routeDeps.decisions!.flushUsage();
    await upstream.stop(true);
    await composition.stopBillingAutoTopUps();
  });
  async function call(
    id = crypto.randomUUID(),
    kind: "decisions" | "chat/completions" = "decisions",
  ) {
    const start = performance.now();
    const response = await fetch(`${api.url.origin}/v1/workspaces/${platform.id}/${kind}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(
        kind === "decisions"
          ? {
              input: id,
              questions: { match: { type: "predicate", instructions: "Matches?" } },
              tenantLabel: customer.id,
            }
          : { model: "local/chat", messages: [{ role: "user", content: id }] },
      ),
    });
    const body = await response.json();
    const total = performance.now() - start;
    return { response, body, total, upstream: durations.get(id) };
  }
  return {
    accountId,
    platform,
    customer,
    key,
    call,
    composition,
    requests: () => requests,
    delay: (value: number) => {
      delayMs = value;
    },
  };
}

test("real HTTP API key, exhausted customer, platform receipts and revocation", async () => {
  const f = await fixture();
  const result = await f.call();
  expect(result.response.status).toBe(200);
  expect(result.body).toMatchObject({
    tenantLabel: f.customer.id,
    answers: { match: { type: "predicate", probability: 0.9 } },
  });
  await f.composition.routeDeps.decisions!.flushUsage();
  const rows =
    await shared.admin`select * from usage_events where account_id = ${f.accountId}::uuid`;
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.workspace_id === f.platform.id)).toBe(true);
  expect(rows.every((row) => row.initiator_context.tenantLabel === f.customer.id)).toBe(true);
  expect(Number(rows.find((row) => row.event_type === "model.provider_cost")?.quantity)).toBe(4000);
  expect(Number(rows.find((row) => row.event_type === "model.cost")?.quantity)).toBe(0);
  const events = await listUsageEvents(client.db, {
    accountId: f.accountId,
    workspaceId: f.platform.id,
    limit: 50,
  });
  expect(events.every((event) => event.tenantLabel === f.customer.id)).toBe(true);
  const [sessions] =
    await shared.admin`select count(*)::int as count from sessions where account_id = ${f.accountId}::uuid`;
  expect(sessions!.count).toBe(0);
  expect(
    await checkWorkspaceAllowance(client.db, {
      accountId: f.accountId,
      workspaceId: f.customer.id,
    }),
  ).toMatchObject({ code: "allowance_exhausted" });
  await shared.admin`update api_keys set revoked_at = now() where id = ${f.key.id}::uuid`;
  expect((await f.call()).response.status).toBe(401);
  expect(f.requests()).toBe(1);
}, 60_000);

test.skipIf(process.env.OPENGENI_BENCH_DECISIONS !== "1")(
  "real HTTP overhead against a controlled provider, including auth and residency",
  async () => {
    const f = await fixture();
    const quantile = (values: number[], fraction: number) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
    for (const kind of ["decisions", "chat/completions"] as const) {
      const samples: Array<{ total: number; upstream: number; added: number }> = [];
      for (let n = -10; n < 120; n++) {
        f.delay(n % 10 === 0 ? 484 : 265);
        const result = await f.call(`${kind}-${n}`, kind);
        expect(result.response.status, JSON.stringify(result.body)).toBe(200);
        expect(result.upstream).toBeDefined();
        if (n >= 0)
          samples.push({
            total: result.total,
            upstream: result.upstream!,
            added: result.total - result.upstream!,
          });
      }
      await f.composition.routeDeps.decisions!.flushUsage();
      console.log(
        JSON.stringify({
          benchmark: kind,
          samples: samples.length,
          transport: "loopback HTTP + PostgreSQL, real API-key auth, serial",
          medianMs: quantile(
            samples.map((s) => s.added),
            0.5,
          ),
          p95Ms: quantile(
            samples.map((s) => s.added),
            0.95,
          ),
          totalMedianMs: quantile(
            samples.map((s) => s.total),
            0.5,
          ),
          totalP95Ms: quantile(
            samples.map((s) => s.total),
            0.95,
          ),
          providerMedianMs: quantile(
            samples.map((s) => s.upstream),
            0.5,
          ),
          providerP95Ms: quantile(
            samples.map((s) => s.upstream),
            0.95,
          ),
        }),
      );
    }
  },
  180_000,
);
