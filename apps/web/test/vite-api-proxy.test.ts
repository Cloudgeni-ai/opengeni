import { expect, test } from "bun:test";
import { createServer, type UserConfig } from "vite";
import config from "../vite.config";

test("development web origin forwards OAuth query bytes and redirects to the API", async () => {
  const requests: string[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.url);
      return new Response(null, {
        status: 302,
        headers: { location: "/workspaces/example/plugins?integration_oauth=connected" },
      });
    },
  });
  const proxy = (config as UserConfig).server?.proxy;
  expect(proxy?.["/v1"]).toBeDefined();
  const server = await createServer({
    configFile: false,
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: { ...proxy, "/v1": { ...(proxy!["/v1"] as object), target: api.url.origin } },
    },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("Missing Vite address");
    const suffix =
      "/v1/integrations/oauth/callback?code=a%2Bb%2Fc&state=one.two%2Bthree&iss=https%3A%2F%2Foauth.example";
    const response = await fetch(`http://127.0.0.1:${address.port}${suffix}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/workspaces/example/plugins?integration_oauth=connected",
    );
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!).pathname + new URL(requests[0]!).search).toBe(suffix);
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
  } finally {
    await server.close();
    api.stop(true);
  }
});
