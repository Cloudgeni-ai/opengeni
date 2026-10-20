import { Hono } from "hono";
import { describe, expect, test } from "bun:test";

import { requireSameOriginBrowserMutation } from "../src/http/browser-mutation-origin";

function app(
  settings: { productAccessMode: string; publicBaseUrl: string | null } = {
    productAccessMode: "local",
    publicBaseUrl: null,
  },
) {
  const api = new Hono();
  api.post("/mutation", (c) => {
    requireSameOriginBrowserMutation(c, { settings } as never);
    return c.json({ ok: true });
  });
  return api;
}

function request(
  origin: string,
  fetchSite: string,
  url = "http://127.0.0.1:8000/mutation",
  settings?: Parameters<typeof app>[0],
) {
  return app(settings).request(url, {
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

describe("managed browser mutation origin", () => {
  const managed = { productAccessMode: "managed", publicBaseUrl: "https://app.example.test" };
  const url = "https://api.example.test/mutation";

  test("accepts only the public origin with same-origin fetch metadata", async () => {
    expect((await request("https://app.example.test", "same-origin", url, managed)).status).toBe(
      200,
    );
    expect((await request("https://app.example.test", "same-site", url, managed)).status).toBe(403);
    expect((await request("https://attacker.test", "same-origin", url, managed)).status).toBe(403);
  });

  test("never takes the local loopback allowance", async () => {
    expect(
      (
        await request(
          "http://127.0.0.1:3000",
          "same-site",
          "http://127.0.0.1:8000/mutation",
          managed,
        )
      ).status,
    ).toBe(403);
  });

  test("fails closed without a configured public origin", async () => {
    expect(
      (
        await request("https://app.example.test", "same-origin", url, {
          productAccessMode: "managed",
          publicBaseUrl: null,
        })
      ).status,
    ).toBe(503);
  });
});
