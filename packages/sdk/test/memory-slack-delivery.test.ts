import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src";

describe("Memory Slack delivery SDK", () => {
  test("uses the configuration, channel, history, and action endpoints", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({
          method: init?.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          body,
        });
        const responseBody = url.pathname.endsWith("/configuration")
          ? init?.method === "PUT"
            ? { id: "c", revision: 1 }
            : { current: null, history: [] }
          : url.pathname.endsWith("/channels")
            ? { channels: [], nextCursor: null }
            : url.pathname.endsWith("/action")
              ? { id: "p", state: "queued" }
              : { publications: [], nextCursor: null };
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    await client.getMemorySlackPublicationConfiguration(workspaceId);
    await client.updateMemorySlackPublicationConfiguration(workspaceId, {
      expectedRevision: 0,
      enabled: false,
      connectionId: null,
      slackChannelId: null,
      slackChannelName: null,
      autoImportances: ["major"],
      reviewImportances: ["normal"],
    });
    await client.listMemorySlackPublicationChannels(workspaceId, "connection-1", "cursor-1");
    await client.listMemorySlackPublications(workspaceId);
    await client.actOnMemorySlackPublication(workspaceId, "publication/1", {
      action: "approve",
      expectedState: "review_pending",
    });
    expect(requests).toEqual([
      {
        method: "GET",
        path: `/v1/workspaces/${workspaceId}/memory-slack-publications/configuration`,
        body: undefined,
      },
      {
        method: "PUT",
        path: `/v1/workspaces/${workspaceId}/memory-slack-publications/configuration`,
        body: expect.objectContaining({ expectedRevision: 0 }),
      },
      {
        method: "GET",
        path: `/v1/workspaces/${workspaceId}/memory-slack-publications/channels?connectionId=connection-1&cursor=cursor-1`,
        body: undefined,
      },
      {
        method: "GET",
        path: `/v1/workspaces/${workspaceId}/memory-slack-publications`,
        body: undefined,
      },
      {
        method: "POST",
        path: `/v1/workspaces/${workspaceId}/memory-slack-publications/publication%2F1/action`,
        body: { action: "approve", expectedState: "review_pending" },
      },
    ]);
  });
});
