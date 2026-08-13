import { describe, expect, test } from "bun:test";

import { OpenGeniClient } from "../src/client";

describe("OpenGeniClient SuperGrok management", () => {
  test("defaults device login to workspace scope and exposes account mutations", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.x.ai/device",
          intervalSeconds: 5,
          expiresInSeconds: 300,
          scope: "workspace",
          state: "signed",
        });
      },
    });

    await client.supergrokConnectStart("workspace-1");
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/v1/workspaces/workspace-1/supergrok/connect/start",
      body: { scope: "workspace" },
    });
  });

  test("preserves an explicit private user scope", async () => {
    let body: unknown = null;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (_input, init) => {
        body = init?.body ? JSON.parse(String(init.body)) : null;
        return Response.json({
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.x.ai/device",
          intervalSeconds: 5,
          expiresInSeconds: 300,
          scope: "user",
          state: "signed",
        });
      },
    });
    await client.supergrokConnectStart("workspace-1", "user");
    expect(body).toEqual({ scope: "user" });
  });
});
