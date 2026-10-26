import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { ApiRouteDeps } from "@opengeni/core";
import { admitManagedSignInMutation } from "../src/routes/managed-sign-in-methods";
import { ApiHttpError } from "../src/http/api-error";

const origin = "https://app.example.com";
const deps = {
  settings: { publicBaseUrl: origin, managedAuthSessionSetMode: "legacy" },
} as ApiRouteDeps;

for (const headers of [
  { origin, "sec-fetch-site": "same-site", "content-type": "application/json" },
  {
    origin: "https://other.example.com",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  },
  { origin, "sec-fetch-site": "cross-site", "content-type": "application/json" },
  { origin, "sec-fetch-site": "same-origin", "content-type": "text/plain" },
  { origin, "content-type": "application/json" },
]) {
  test(`rejects unsafe mutation before identity/database work: ${JSON.stringify(headers)}`, async () => {
    const app = new Hono();
    let admitted = false;
    let caught: Error | undefined;
    app.onError((error, c) => {
      caught = error;
      return c.json({ rejected: true }, 403);
    });
    app.post("/", async (c) => {
      await admitManagedSignInMutation(c, deps);
      admitted = true;
      return c.json({ admitted });
    });
    const response = await app.request(origin, { method: "POST", headers });
    expect(response.status).toBe(403);
    expect(admitted).toBe(false);
    expect(caught).toBeInstanceOf(ApiHttpError);
    expect(caught).toMatchObject({
      status: 403,
      details: { code: "SIGN_IN_METHOD_SAME_ORIGIN_REQUIRED" },
      retryable: false,
    });
  });
}

test("same-origin JSON admission is preserved", async () => {
  const app = new Hono();
  app.post("/", async (c) => {
    await admitManagedSignInMutation(c, deps);
    return c.json({ admitted: true });
  });
  const response = await app.request(origin, {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json; charset=utf-8",
    },
  });
  expect(response.status).toBe(200);
});

test("a trusted second hostname of the same deployment is admitted", async () => {
  const secondOrigin = "https://agents.example.org";
  const twoHosts = {
    settings: {
      publicBaseUrl: origin,
      betterAuthTrustedOrigins: secondOrigin,
      managedAuthSessionSetMode: "legacy",
    },
  } as ApiRouteDeps;
  const app = new Hono();
  app.onError((_error, c) => c.json({ rejected: true }, 403));
  app.post("/", async (c) => {
    await admitManagedSignInMutation(c, twoHosts);
    return c.json({ admitted: true });
  });
  const admitted = await app.request(secondOrigin, {
    method: "POST",
    headers: {
      origin: secondOrigin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  expect(admitted.status).toBe(200);
  const untrusted = await app.request(secondOrigin, {
    method: "POST",
    headers: {
      origin: "https://other.example.com",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  expect(untrusted.status).toBe(403);
});
