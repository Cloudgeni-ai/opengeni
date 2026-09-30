import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/index";

describe("embedding transport helpers", () => {
  test("withHeaders scopes every request and keeps the host fetch and headers", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://product.example.test/api/opengeni",
      headers: () => ({ authorization: "Bearer host-token" }),
      fetch: async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        return Response.json({ artifact: { id: "a" }, versions: [] });
      },
    });
    const scoped = client.withHeaders({ "x-opengeni-session-id": "session-1" });
    expect(scoped).toBeInstanceOf(OpenGeniClient);
    await scoped.getWorkspaceArtifact("ws", "a");
    expect(seen[0]!.headers.get("x-opengeni-session-id")).toBe("session-1");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer host-token");
    await client.getWorkspaceArtifact("ws", "a");
    expect(seen[1]!.headers.get("x-opengeni-session-id")).toBeNull();
    expect(client.apiUrl("/v1/x")).toBe("https://product.example.test/api/opengeni/v1/x");
  });

  test("fetchApi only reaches the client's API base", async () => {
    const seen: string[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://product.example.test/api/opengeni",
      headers: { authorization: "Bearer host-token" },
      fetch: async (input, init) => {
        seen.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
        return new Response("{}");
      },
    });
    await client.fetchApi("https://product.example.test/api/opengeni/v1/tickets", {
      method: "POST",
    });
    expect(seen).toEqual([
      "https://product.example.test/api/opengeni/v1/tickets Bearer host-token",
    ]);
    for (const outside of [
      "https://elsewhere.example.test/api/opengeni/v1/tickets",
      "https://product.example.test/api/opengeni-evil/v1",
      "https://product.example.test/other",
    ]) {
      await expect(client.fetchApi(outside)).rejects.toThrow(TypeError);
    }
    expect(seen).toHaveLength(1);
  });
});
