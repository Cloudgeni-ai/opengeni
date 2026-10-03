import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { OpenGeniClient } from "../src/client";
import { OpenGeniBrowserClient as BrowserClient } from "../src/browser";
import { OpenGeniClient as PublicClient } from "../src/index";
import type * as Contracts from "@opengeni/contracts/insights-usage";
import type * as Sdk from "@opengeni/sdk/insights-usage";
import type { OpenGeniRequestOptions } from "../src/client";

const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

test("SDK signatures and type-only exports match the new dedicated contract", () => {
  const usage: Equal<Sdk.InsightsUsageResponse, Contracts.InsightsUsageResponse> = true;
  const calls: Equal<Sdk.InsightsCallsResponse, Contracts.InsightsCallsResponse> = true;
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
  expect([usage, calls]).toEqual([true, true]);
  expect(
    [workspace, organization, workspaceCalls, organizationCalls].every(
      (value) => typeof value === "function",
    ),
  ).toBe(true);
  const noWorkspaceGrouping: Sdk.WorkspaceInsightsUsageOptions = {
    // @ts-expect-error workspace grouping is organization-only
    groupBy: "workspace",
  };
  const noWorkspaceFilter: Sdk.WorkspaceInsightsCallsOptions = {
    // @ts-expect-error workspace filters are organization-only
    workspaceId: id,
  };
  expect(noWorkspaceGrouping).toBeDefined();
  expect(noWorkspaceFilter).toBeDefined();
});

function fixture() {
  const requests: Request[] = [];
  const result = { fixture: "returned unchanged" };
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

describe("shared Insights SDK requests", () => {
  test("workspace usage repeats every array filter and preserves strict false and model slashes", async () => {
    const { client, requests, result } = fixture();
    const value: unknown = await client.getWorkspaceInsightsUsage(id, {
      range: "90d",
      groupBy: "rootSession",
      seriesGroups: false,
      limit: 200,
      provider: ["openrouter", "anthropic"],
      model: ["openrouter/vendor/model/name", "anthropic/claude"],
      payer: ["opengeni_credits", "subscription", "own_key"],
      projectId: [id, "unfiled"],
      person: ["opaque:one", "opaque:two"],
      rootSessionId: [id, secondId],
      scheduleId: [id, secondId],
    });
    expect(value).toEqual(result);
    const request = requests[0]!;
    const url = new URL(request.url);
    expect(url.pathname).toBe(`/v1/workspaces/${id}/insights/usage`);
    expect(url.searchParams.getAll("provider")).toEqual(["openrouter", "anthropic"]);
    expect(url.searchParams.getAll("model")).toEqual([
      "openrouter/vendor/model/name",
      "anthropic/claude",
    ]);
    expect(url.searchParams.getAll("payer")).toEqual([
      "opengeni_credits",
      "subscription",
      "own_key",
    ]);
    expect(url.searchParams.getAll("projectId")).toEqual([id, "unfiled"]);
    expect(url.searchParams.getAll("person")).toEqual(["opaque:one", "opaque:two"]);
    expect(url.searchParams.getAll("rootSessionId")).toEqual([id, secondId]);
    expect(url.searchParams.getAll("scheduleId")).toEqual([id, secondId]);
    expect(url.searchParams.get("seriesGroups")).toBe("false");
    expect(url.searchParams.get("limit")).toBe("200");
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    expect(await request.text()).toBe("");
  });

  test("organization usage repeats workspace IDs at its scoped route", async () => {
    const { client, requests } = fixture();
    await client.getOrganizationInsightsUsage(id, {
      range: "30d",
      groupBy: "workspace",
      workspaceId: [id, secondId],
      seriesGroups: true,
    });
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe(`/v1/organizations/${id}/insights/usage`);
    expect(url.searchParams.getAll("workspaceId")).toEqual([id, secondId]);
    expect(url.searchParams.get("groupBy")).toBe("workspace");
    expect(url.searchParams.get("seriesGroups")).toBe("true");
  });

  test("calls use both scoped endpoints and encode opaque cursor losslessly", async () => {
    const { client, requests } = fixture();
    await client.listInsightsCalls(
      { kind: "workspace", workspaceId: id },
      { range: "today", cursor: "a+/=?&#", limit: 100, model: "openrouter/vendor/model" },
    );
    await client.listInsightsCalls(
      { kind: "organization", accountId: id },
      { workspaceId: [id, secondId], payer: ["subscription", "own_key"], cursor: "next" },
    );
    const workspace = new URL(requests[0]!.url);
    const organization = new URL(requests[1]!.url);
    expect(workspace.pathname).toBe(`/v1/workspaces/${id}/insights/calls`);
    expect(workspace.searchParams.get("cursor")).toBe("a+/=?&#");
    expect(workspace.searchParams.get("limit")).toBe("100");
    expect(workspace.searchParams.getAll("model")).toEqual(["openrouter/vendor/model"]);
    expect(organization.pathname).toBe(`/v1/organizations/${id}/insights/calls`);
    expect(organization.searchParams.getAll("workspaceId")).toEqual([id, secondId]);
    expect(organization.searchParams.getAll("payer")).toEqual(["subscription", "own_key"]);
  });

  test("empty options defer to server defaults without a trailing query marker", async () => {
    const { client, requests } = fixture();
    await client.getWorkspaceInsightsUsage(id);
    await client.getOrganizationInsightsUsage(id);
    await client.listInsightsCalls({ kind: "workspace", workspaceId: id });
    expect(requests.map((request) => request.url)).toEqual([
      `https://api.example.test/v1/workspaces/${id}/insights/usage`,
      `https://api.example.test/v1/organizations/${id}/insights/usage`,
      `https://api.example.test/v1/workspaces/${id}/insights/calls`,
    ]);
  });

  test("cancellation is forwarded separately for all three methods", async () => {
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
      const options = { signal: controller.signal };
      const pending =
        operation === "workspace"
          ? client.getWorkspaceInsightsUsage(id, {}, options)
          : operation === "organization"
            ? client.getOrganizationInsightsUsage(id, {}, options)
            : client.listInsightsCalls({ kind: "organization", accountId: id }, {}, options);
      await ready;
      expect(new URL(request.url).searchParams.has("signal")).toBe(false);
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(request.signal.aborted).toBe(true);
    }
  });

  test("methods are inherited by public and browser client surfaces", () => {
    for (const Client of [PublicClient, BrowserClient]) {
      expect(typeof Client.prototype.getWorkspaceInsightsUsage).toBe("function");
      expect(typeof Client.prototype.getOrganizationInsightsUsage).toBe("function");
      expect(typeof Client.prototype.listInsightsCalls).toBe("function");
    }
  });

  test("focused SDK subpath has no contracts or zod runtime", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(manifest.exports["./insights-usage"]).toEqual({
      types: "./src/insights-usage.ts",
      default: "./src/insights-usage.ts",
    });
    expect(await Bun.file(new URL("../tsup.config.ts", import.meta.url)).text()).toContain(
      '"src/insights-usage.ts"',
    );
    const build = await Bun.build({
      entrypoints: [fileURLToPath(import.meta.resolve("@opengeni/sdk/insights-usage"))],
      target: "browser",
      minify: true,
    });
    expect(build.success).toBe(true);
    const source = await build.outputs[0]!.text();
    expect(source.length).toBeLessThan(3_000);
    expect(source).not.toContain("Zod");
    expect(source).not.toContain("InsightsUsageResponse");
  });
});
