import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { OpenGeniAutomationsClient } from "../src/automations";

describe("automations SDK", () => {
  test("maps source, trigger, run, and manual-event methods to canonical routes", async () => {
    const requests: Request[] = [];
    const transport = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const body = request.url.endsWith("/sources")
          ? '{"sources":[]}'
          : request.url.endsWith("/triggers")
            ? '{"triggers":[]}'
            : request.url.endsWith("/runs")
              ? '{"runs":[]}'
              : '{"accepted":true,"duplicate":false,"ignoredReason":null,"eventId":null,"runIds":[]}';
        return new Response(body, { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const client = new OpenGeniAutomationsClient(transport);
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const sourceId = "22222222-2222-4222-8222-222222222222";

    await client.listSources(workspaceId);
    await client.listTriggers(workspaceId);
    await client.listRuns(workspaceId);
    await client.triggerManually(workspaceId, sourceId, {
      eventType: "build.failed",
      occurrenceKey: "repo:abc",
      payload: {},
      occurredAt: null,
      subject: null,
      resource: null,
    });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `https://api.example.test/v1/workspaces/${workspaceId}/automations/sources`],
      ["GET", `https://api.example.test/v1/workspaces/${workspaceId}/automations/triggers`],
      ["GET", `https://api.example.test/v1/workspaces/${workspaceId}/automations/runs`],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${workspaceId}/automations/sources/${sourceId}/events`,
      ],
    ]);
  });
});
