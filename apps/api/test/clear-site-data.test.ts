import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { clearSiteDataOnSignOut, SIGN_OUT_CLEAR_SITE_DATA } from "../src/http/clear-site-data";

// CASA 6.6.1: a successful sign-out tells the browser to drop its HTTP cache,
// and never its cookies (embedding hosts) or storage (unfinished uploads).

describe("Clear-Site-Data on sign-out", () => {
  const app = new Hono();
  app.use("/v1/auth/sign-out", clearSiteDataOnSignOut);
  app.post("/v1/auth/sign-out", (c) =>
    c.req.header("x-fail") ? c.json({ error: "no" }, 401) : c.json({ success: true }),
  );
  app.get("/v1/auth/sign-out", (c) => c.json({ ok: true }));

  test("a successful sign-out clears the cache only", async () => {
    const response = await app.request("/v1/auth/sign-out", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("clear-site-data")).toBe('"cache"');
    expect(SIGN_OUT_CLEAR_SITE_DATA).not.toContain("cookies");
    expect(SIGN_OUT_CLEAR_SITE_DATA).not.toContain("storage");
    expect(await response.json()).toEqual({ success: true });
  });

  test("a refused sign-out or a read clears nothing", async () => {
    const refused = await app.request("/v1/auth/sign-out", {
      method: "POST",
      headers: { "x-fail": "1" },
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("clear-site-data")).toBeNull();
    const read = await app.request("/v1/auth/sign-out");
    expect(read.headers.get("clear-site-data")).toBeNull();
  });

  test("an immutable provider response still gets the header", async () => {
    const provider = new Hono();
    provider.use("/v1/auth/sign-out", clearSiteDataOnSignOut);
    provider.post("/v1/auth/sign-out", async () => {
      const upstream = await fetch("data:application/json,%7B%22success%22%3Atrue%7D");
      return upstream;
    });
    const response = await provider.request("/v1/auth/sign-out", { method: "POST" });
    expect(response.headers.get("clear-site-data")).toBe('"cache"');
  });
});
