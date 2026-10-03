import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src/index";
import { OpenGeniCoreClient } from "../src/core";
import { OpenGeniBrowserClient } from "../src/browser";

for (const [name, Client] of [
  ["root", OpenGeniClient],
  ["core", OpenGeniCoreClient],
  ["browser", OpenGeniBrowserClient],
] as const) {
  test(`${name} retains legacy usage reads with the caller's transport`, async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const response = { marker: name };
    const client = new Client({
      baseUrl: "https://api.example.test",
      apiKey: "caller-key",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json(response);
      },
    });
    expect(await client.getOrganizationUsageSummary({ accountId: "organization" })).toEqual(
      response,
    );
    expect(
      await client.getOrganizationUsageWorkspacePage({
        accountId: "organization",
        period: "week",
        until: "2026-10-03T12:00:00Z",
        afterWorkspaceId: "workspace-cursor",
      }),
    ).toEqual(response);
    const summary = new URL(requests[0]!.url);
    const page = new URL(requests[1]!.url);
    expect(summary.pathname).toBe("/v1/billing/usage-summary");
    expect(Object.fromEntries(summary.searchParams)).toEqual({
      accountId: "organization",
      period: "month",
    });
    expect(page.pathname).toBe("/v1/billing/usage-workspaces");
    expect(Object.fromEntries(page.searchParams)).toEqual({
      accountId: "organization",
      period: "week",
      until: "2026-10-03T12:00:00Z",
      afterWorkspaceId: "workspace-cursor",
    });
    for (const request of requests) {
      expect(request.init?.method).toBe("GET");
      expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer caller-key");
    }
    const controller = new AbortController();
    const reason = new Error("cancel before usage read");
    controller.abort(reason);
    await expect(
      client.getOrganizationUsageSummary(
        { accountId: "organization" },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(requests).toHaveLength(2);
  });
}
