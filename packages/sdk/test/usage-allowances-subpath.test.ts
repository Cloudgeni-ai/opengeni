import { describe, expect, test } from "bun:test";

import { OpenGeniBrowserClient } from "../src/browser";
import {
  getAllUsage,
  getMyUsage,
  getUsage,
  getWorkspaceAllowanceState,
  setMemberAllowance,
  setWorkspaceAllowance,
  usageAllowanceQuery,
} from "../src/usage-allowances";

function page(members: string[], nextCursor: string | null) {
  return {
    period: { start: null, end: null },
    workspace: {
      limit: 10,
      used: 1,
      remaining: 9,
      fraction: 0.1,
      status: "ok",
      resetsAt: null,
      includedCredits: 10,
      grantsRemaining: 0,
    },
    members: members.map((subjectId) => ({
      subjectId,
      externalIdentity: null,
      rule: null,
      version: 0,
      limit: null,
      used: 0,
      remaining: null,
      fraction: null,
      status: "ok",
      resetsAt: null,
    })),
    nextCursor,
  };
}

function browserFixture(respond: (url: URL) => unknown = () => ({ ok: true })) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const client = new OpenGeniBrowserClient({
    baseUrl: "https://console.test",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const text = await request.text();
      const url = new URL(request.url);
      calls.push({ method: request.method, url, body: text ? JSON.parse(text) : undefined });
      return Response.json(respond(url));
    },
  });
  return { client, calls };
}

describe("@opengeni/sdk/usage-allowances", () => {
  test("works over the narrow browser client's requestJson", async () => {
    const { client, calls } = browserFixture();
    await getMyUsage(client, "ws/a", { period: "2026-09" });
    await getUsage(client, "ws/a", { limit: 5, cursor: "c" });
    await getWorkspaceAllowanceState(client, "ws/a");
    await setWorkspaceAllowance(client, "ws/a", {
      includedCredits: 500_000_000,
      period: "monthly",
      anchorDay: 1,
      memberDefault: "equal_share",
      expectedVersion: 0,
    });
    await setMemberAllowance(client, "ws/a", "user:a/b", {
      rule: { share: 0.3 },
      expectedVersion: 0,
    });
    await setMemberAllowance(
      client,
      "ws/a",
      { source: "acme", externalId: "u/1" },
      { rule: null, expectedVersion: 3 },
    );
    expect(calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`)).toEqual([
      "GET /v1/workspaces/ws%2Fa/usage/me?period=2026-09",
      "GET /v1/workspaces/ws%2Fa/usage?limit=5&cursor=c",
      "GET /v1/workspaces/ws%2Fa/allowance/state",
      "PUT /v1/workspaces/ws%2Fa/allowance",
      "PUT /v1/workspaces/ws%2Fa/members/user%3Aa%2Fb/allowance",
      "PUT /v1/workspaces/ws%2Fa/members/external/acme/u%2F1/allowance",
    ]);
    expect(calls[4]?.body).toEqual({ rule: { share: 0.3 }, expectedVersion: 0 });
  });

  test("getAllUsage follows cursors for one period and stops on a repeated cursor", async () => {
    const pages: Record<string, unknown> = {
      "": page(["a", "b"], "p2"),
      p2: page(["c"], "p3"),
      p3: page(["d"], "p2"),
    };
    const { client, calls } = browserFixture((url) => pages[url.searchParams.get("cursor") ?? ""]);
    const all = await getAllUsage(client, "ws", { period: "current" });
    expect(all.members.map((member) => member.subjectId)).toEqual(["a", "b", "c", "d"]);
    expect(all.nextCursor).toBeNull();
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.url.searchParams.get("period") === "current")).toBe(true);
    expect(calls.every((call) => call.url.searchParams.get("limit") === "200")).toBe(true);
  });

  test("query strings keep only defined values", () => {
    expect(usageAllowanceQuery({ period: "current", limit: undefined })).toEqual({
      period: "current",
    });
  });
});
