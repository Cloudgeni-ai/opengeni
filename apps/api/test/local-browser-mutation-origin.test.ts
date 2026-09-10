import { Hono } from "hono";
import { describe, expect, test } from "bun:test";

import { requireSameOriginBrowserMutation } from "../src/routes/codex";

function app() {
  const api = new Hono();
  api.post("/mutation", (c) => {
    requireSameOriginBrowserMutation(c, {
      settings: { productAccessMode: "local", publicBaseUrl: null },
    } as never);
    return c.json({ ok: true });
  });
  return api;
}

function request(origin: string, fetchSite: string, url = "http://127.0.0.1:8000/mutation") {
  return app().request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: new URL(url).host,
      origin,
      "sec-fetch-site": fetchSite,
    },
    body: "{}",
  });
}

describe("local browser mutation origin", () => {
  test("allows the local web and API on different ports", async () => {
    expect((await request("http://127.0.0.1:3000", "same-site")).status).toBe(200);
  });

  test("allows localhost-to-loopback alias used by local browser links", async () => {
    expect((await request("http://localhost:3000", "cross-site")).status).toBe(200);
  });

  test("rejects a non-local or mismatched browser origin", async () => {
    expect((await request("https://attacker.test", "cross-site")).status).toBe(403);
    expect((await request("http://other-host:3000", "same-site")).status).toBe(403);
  });
});
