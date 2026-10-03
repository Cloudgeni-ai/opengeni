import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { OpenGeniClient } from "../src/client";
import { OpenGeniBrowserClient } from "../src/browser";
import { OpenGeniClient as PublicClient } from "../src/index";
import type { OpenGeniRequestOptions } from "../src/client";
import type * as Contracts from "@opengeni/contracts/insights-usage";
import {
  OrganizationInsightsUsageQuery,
  OrganizationInsightsCallsQuery,
} from "@opengeni/contracts/insights-usage";
import type * as Sdk from "@opengeni/sdk/insights-usage";

const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

test("SDK signatures/type-only DTOs and custom-window options match the dedicated contract", () => {
  const equal: [
    Equal<Sdk.InsightsUsageResponse, Contracts.InsightsUsageResponse>,
    Equal<Sdk.InsightsCallsResponse, Contracts.InsightsCallsResponse>,
  ] = [true, true];
  const workspace: (
    id: string,
    options?: Sdk.WorkspaceInsightsUsageOptions,
    request?: OpenGeniRequestOptions,
  ) => Promise<Contracts.InsightsUsageResponse> =
    OpenGeniClient.prototype.getWorkspaceInsightsUsage;
  const organization: (
    id: string,
    options?: Sdk.OrganizationInsightsUsageOptions,
    request?: OpenGeniRequestOptions,
  ) => Promise<Contracts.InsightsUsageResponse> =
    OpenGeniClient.prototype.getOrganizationInsightsUsage;
  const workspaceCalls: (
    scope: { kind: "workspace"; workspaceId: string },
    options?: Sdk.WorkspaceInsightsCallsOptions,
    request?: OpenGeniRequestOptions,
  ) => Promise<Contracts.InsightsCallsResponse> = OpenGeniClient.prototype.listInsightsCalls;
  const organizationCalls: (
    scope: { kind: "organization"; accountId: string },
    options?: Sdk.OrganizationInsightsCallsOptions,
    request?: OpenGeniRequestOptions,
  ) => Promise<Contracts.InsightsCallsResponse> = OpenGeniClient.prototype.listInsightsCalls;
  expect(equal).toEqual([true, true]);
  expect(
    [workspace, organization, workspaceCalls, organizationCalls].every(
      (method) => typeof method === "function",
    ),
  ).toBe(true);
  const workspaceOptions: Sdk.WorkspaceInsightsUsageOptions = {
    workspaceId: id,
    groupBy: "workspace",
  };
  const custom: Sdk.WorkspaceInsightsCallsOptions = {
    range: "custom",
    from: "2026-10-01",
    to: "2026-10-02",
    source: ["api", "other"],
  };
  // @ts-expect-error custom requires both calendar dates
  const missingEnd: Sdk.WorkspaceInsightsUsageOptions = { range: "custom", from: "2026-10-01" };
  // @ts-expect-error presets cannot silently ignore custom dates
  const presetDays: Sdk.WorkspaceInsightsUsageOptions = {
    range: "today",
    from: "2026-10-01",
    to: "2026-10-02",
  };
  // @ts-expect-error missing source is other, never an invented unknown enum
  const invalidSource: Sdk.WorkspaceInsightsUsageOptions = { source: "unknown" };
  // @ts-expect-error false is a boolean, not an arbitrary coerced query string
  const invalidBoolean: Sdk.WorkspaceInsightsUsageOptions = { seriesGroups: "false" };
  expect([
    workspaceOptions,
    custom,
    missingEnd,
    presetDays,
    invalidSource,
    invalidBoolean,
  ]).toHaveLength(6);
});

function fixture(result: unknown = { fixture: "returned unchanged" }) {
  const requests: Request[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-key",
    fetch: (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(result);
    }) as typeof fetch,
  });
  return { client, requests, result };
}

describe("expanded shared Insights SDK requests", () => {
  test("workspace usage repeats all filters, preserves false/slashes and does not mutate options", async () => {
    const { client, requests, result } = fixture();
    const options: Sdk.WorkspaceInsightsUsageOptions = {
      range: "90d",
      groupBy: "session",
      seriesGroups: false,
      limit: 200,
      workspaceId: [id, secondId],
      provider: ["openrouter", "anthropic"],
      model: ["openrouter/vendor/model/name", "anthropic/claude"],
      payer: ["opengeni_credits", "subscription", "own_key"],
      plan: ["recorded:plan", "unknown"],
      source: ["web", "api", "slack", "schedule", "agent", "other"],
      projectId: [id, "unfiled"],
      person: ["member:one", "member:two"],
      sessionId: [id, secondId],
      rootSessionId: [secondId, id],
      scheduleId: [id, secondId],
    };
    const before = structuredClone(options);
    const received: unknown = await client.getWorkspaceInsightsUsage(id, options);
    expect(received).toEqual(result);
    expect(options).toEqual(before);
    const request = requests[0]!;
    const url = new URL(request.url);
    expect(url.pathname).toBe(`/v1/workspaces/${id}/insights/usage`);
    for (const [key, value] of Object.entries(options))
      expect(url.searchParams.getAll(key)).toEqual(
        (Array.isArray(value) ? value : [value]).map(String),
      );
    expect(url.searchParams.get("seriesGroups")).toBe("false");
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    expect(await request.text()).toBe("");
  });

  test("organization usage encodes custom calendar days and recorded source/plan selectors", async () => {
    const { client, requests } = fixture();
    await client.getOrganizationInsightsUsage(id, {
      range: "custom",
      from: "2026-10-01",
      to: "2026-10-02",
      workspaceId: [id, secondId],
      groupBy: "source",
      source: ["api", "other"],
      plan: ["historical", "unknown"],
      seriesGroups: true,
    });
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe(`/v1/organizations/${id}/insights/usage`);
    const query = OrganizationInsightsUsageQuery.parse(
      Object.fromEntries(
        [...new Set(url.searchParams.keys())].map((key) => [
          key,
          ["range", "from", "to", "groupBy", "seriesGroups"].includes(key)
            ? url.searchParams.get(key)
            : url.searchParams.getAll(key),
        ]),
      ),
    );
    expect(query).toMatchObject({
      range: "custom",
      from: "2026-10-01",
      to: "2026-10-02",
      groupBy: "source",
      source: ["api", "other"],
      plan: ["historical", "unknown"],
      workspaceId: [id, secondId],
      seriesGroups: true,
    });
  });

  test("comma/mixed values and empty segments survive serialization for strict server validation", async () => {
    const { client, requests } = fixture();
    await client.getOrganizationInsightsUsage(id, {
      workspaceId: `${id},${secondId}`,
      provider: ["openrouter,anthropic", "openrouter"],
      model: "openrouter/vendor/model/name,anthropic/claude",
      plan: "historical,unknown",
      seriesGroups: false,
    });
    const params = new URL(requests[0]!.url).searchParams;
    expect(
      OrganizationInsightsUsageQuery.parse({
        workspaceId: params.getAll("workspaceId"),
        provider: params.getAll("provider"),
        model: params.getAll("model"),
        plan: params.getAll("plan"),
        seriesGroups: params.get("seriesGroups"),
      }),
    ).toMatchObject({
      workspaceId: [id, secondId],
      provider: ["openrouter", "anthropic", "openrouter"],
      model: ["openrouter/vendor/model/name", "anthropic/claude"],
      plan: ["historical", "unknown"],
      seriesGroups: false,
    });
    await client.getWorkspaceInsightsUsage(id, { provider: "valid," });
    const provider = new URL(requests[1]!.url).searchParams.getAll("provider");
    expect(provider).toEqual(["valid,"]);
    expect(OrganizationInsightsUsageQuery.safeParse({ provider }).success).toBe(false);
  });

  test("both calls scopes share expanded filters/custom days and preserve opaque cursor", async () => {
    const { client, requests } = fixture();
    const options: Sdk.OrganizationInsightsCallsOptions = {
      range: "custom",
      from: "2026-10-01",
      to: "2026-10-03",
      workspaceId: [id, secondId],
      sessionId: id,
      rootSessionId: secondId,
      person: "member:opaque",
      source: ["api", "other"],
      plan: "unknown",
      cursor: "a+/=?&#",
      limit: 100,
    };
    await client.listInsightsCalls({ kind: "workspace", workspaceId: id }, options);
    await client.listInsightsCalls({ kind: "organization", accountId: id }, options);
    for (const [index, scope] of ["workspaces", "organizations"].entries()) {
      const url = new URL(requests[index]!.url);
      expect(url.pathname).toBe(`/v1/${scope}/${id}/insights/calls`);
      expect(url.searchParams.get("cursor")).toBe(options.cursor!);
      expect(url.searchParams.has("groupBy")).toBe(false);
      expect(OrganizationInsightsCallsQuery.parse({ ...options })).toMatchObject({
        source: ["api", "other"],
        sessionId: [id],
        rootSessionId: [secondId],
        person: ["member:opaque"],
        workspaceId: [id, secondId],
        limit: 100,
      });
    }
  });

  test("defaults leave no trailing query marker and route identifiers are encoded", async () => {
    const { client, requests } = fixture();
    await client.getWorkspaceInsightsUsage(id);
    await client.getOrganizationInsightsUsage(id);
    await client.listInsightsCalls({ kind: "workspace", workspaceId: id });
    await client.listInsightsCalls({ kind: "organization", accountId: "opaque/id?" });
    expect(
      requests.map((request) => new URL(request.url).pathname + new URL(request.url).search),
    ).toEqual([
      `/v1/workspaces/${id}/insights/usage`,
      `/v1/organizations/${id}/insights/usage`,
      `/v1/workspaces/${id}/insights/calls`,
      "/v1/organizations/opaque%2Fid%3F/insights/calls",
    ]);
  });

  test("basic usage and calls requests never opt into deferred dimensions or custom windows", async () => {
    const { client, requests } = fixture();
    const usage: Sdk.WorkspaceInsightsUsageOptions = {
      range: "30d",
      groupBy: "model",
      seriesGroups: false,
      provider: ["anthropic", "openai"],
    };
    const calls: Sdk.WorkspaceInsightsCallsOptions = {
      range: "week",
      limit: 50,
      cursor: "opaque+cursor/=",
      provider: ["anthropic", "openai"],
    };
    await client.getWorkspaceInsightsUsage(id, usage);
    await client.getOrganizationInsightsUsage(id, usage);
    await client.listInsightsCalls({ kind: "workspace", workspaceId: id }, calls);
    await client.listInsightsCalls({ kind: "organization", accountId: id }, calls);
    for (const [index, request] of requests.entries()) {
      const expected = index < 2 ? usage : calls;
      const params = new URL(request.url).searchParams;
      expect([...new Set(params.keys())].sort()).toEqual(Object.keys(expected).sort());
      for (const [key, value] of Object.entries(expected))
        expect(params.getAll(key)).toEqual((Array.isArray(value) ? value : [value]).map(String));
    }
  });

  test("both usage scopes preserve an absent capability marker and zero-fact ledger prior", async () => {
    const zeroPayer = { calls: 0, chargedMicros: 0, listMicros: 0 };
    const empty: Contracts.InsightsUsageMeasures = {
      calls: 0,
      tokenKnownCalls: 0,
      cacheKnownCalls: 0,
      cacheWriteKnownCalls: 0,
      listClassKnownCalls: 0,
      tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      chargedMicros: 0,
      listMicros: 0,
      listByClassMicros: null,
      listByClassApprox: false,
      pricedCalls: 0,
      byPayer: {
        opengeni_credits: { ...zeroPayer },
        subscription: { ...zeroPayer },
        own_key: { ...zeroPayer },
      },
    };
    for (const kind of ["workspace", "organization"] as const) {
      const result: Contracts.InsightsUsageResponse = {
        scope:
          kind === "workspace"
            ? { kind, accountId: id, workspaceId: secondId }
            : { kind, accountId: id, workspaceId: null },
        range: "week",
        windowStart: "2026-09-28T00:00:00Z",
        windowEnd: "2026-10-03T10:00:00Z",
        priorWindowStart: "2026-09-21T00:00:00Z",
        priorWindowEnd: "2026-09-26T10:00:00Z",
        bucket: "day",
        generatedAt: "2026-10-03T10:00:00Z",
        dataThrough: null,
        totals: empty,
        prior: {
          ...empty,
          chargedMicros: 23,
          byPayer: { ...empty.byPayer, opengeni_credits: { ...zeroPayer, chargedMicros: 23 } },
        },
        groupBy: "model",
        groups: [],
        groupCount: 0,
        groupsTruncated: false,
        series: [],
        facets: {
          workspaces: [],
          providers: [],
          models: [],
          payers: [],
          plans: [],
          projects: [],
          people: [],
          schedules: [],
        },
      };
      const { client, requests } = fixture(result);
      const received =
        kind === "workspace"
          ? await client.getWorkspaceInsightsUsage(secondId)
          : await client.getOrganizationInsightsUsage(id);
      expect(received).toEqual(result);
      expect(Object.hasOwn(received.facets, "sources")).toBe(false);
      expect(Array.isArray(received.facets.sources)).toBe(false);
      expect(received.prior?.chargedMicros).toBe(23);
      expect(received.prior?.calls).toBe(0);
      expect(received.prior?.tokenKnownCalls).toBe(0);
      expect(new URL(requests[0]!.url).search).toBe("");
    }
  });

  test("cancellation is forwarded separately for all methods", async () => {
    for (const operation of ["workspace", "organization", "calls"] as const) {
      const controller = new AbortController();
      let request!: Request;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const client = new OpenGeniClient({
        baseUrl: "https://api.example.test",
        fetch: (async (input, init) => {
          request = new Request(input, init);
          started();
          return await new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            });
          });
        }) as typeof fetch,
      });
      const requestOptions = { signal: controller.signal };
      const pending =
        operation === "workspace"
          ? client.getWorkspaceInsightsUsage(id, {}, requestOptions)
          : operation === "organization"
            ? client.getOrganizationInsightsUsage(id, {}, requestOptions)
            : client.listInsightsCalls({ kind: "organization", accountId: id }, {}, requestOptions);
      await ready;
      expect(new URL(request.url).searchParams.has("signal")).toBe(false);
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(request.signal.aborted).toBe(true);
    }
  });

  test("public/browser clients inherit all methods, focused SDK leaf loads no zod/contracts runtime", async () => {
    for (const Client of [PublicClient, OpenGeniBrowserClient]) {
      expect(Client.prototype.getWorkspaceInsightsUsage).toBeFunction();
      expect(Client.prototype.getOrganizationInsightsUsage).toBeFunction();
      expect(Client.prototype.listInsightsCalls).toBeFunction();
    }
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(manifest.exports["./insights-usage"]).toEqual({
      types: "./src/insights-usage.ts",
      default: "./src/insights-usage.ts",
    });
    const build = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve("@opengeni/sdk/insights-usage"))],
      target: "browser",
      minify: true,
    });
    expect(build.success).toBe(true);
    const source = await build.outputs[0]!.text();
    expect(source.length).toBeLessThan(3000);
    expect(source).not.toContain("Zod");
    expect(source).not.toContain("InsightsUsageResponse");
  });
});
