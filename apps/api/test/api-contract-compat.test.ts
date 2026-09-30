import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";
import { bearerApiContractHeaderCompatibility } from "../src/http/api-contract-compat";

function fencedApp(): Hono {
  const app = new Hono();
  app.use("/v1/*", bearerApiContractHeaderCompatibility());
  app.use("/v1/*", async (c, next) => {
    c.header(OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION);
    await next();
  });
  app.get("/v1/ok", (c) => c.json({ ok: true }));
  app.post("/v1/refused", (c) => c.json({ code: "API_CONTRACT_CHANGED", message: "reload" }, 409));
  app.post("/v1/conflict", (c) => c.json({ code: "IDEMPOTENCY_CONFLICT" }, 409));
  return app;
}

const OLD = "2026-01-some-older-revision";

async function advertised(
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<string | null> {
  const response = await fencedApp().request(path, { method, headers });
  return response.headers.get(OPENGENI_API_CONTRACT_HEADER);
}

describe("bearer API contract header compatibility", () => {
  test("omits the revision a pinned bearer SDK would reject", async () => {
    expect(
      await advertised("/v1/ok", {
        authorization: "Bearer ogk_key",
        [OPENGENI_API_CONTRACT_HEADER]: OLD,
      }),
    ).toBeNull();
    // An ordinary conflict is not a contract refusal: the old SDK must see the
    // real error, not a contract mismatch.
    expect(
      await advertised(
        "/v1/conflict",
        { authorization: "Bearer ogk_key", [OPENGENI_API_CONTRACT_HEADER]: OLD },
        "POST",
      ),
    ).toBeNull();
  });

  test("keeps the header for matching, cookie, unauthenticated, and refused callers", async () => {
    const current = OPENGENI_API_CONTRACT_REVISION;
    expect(
      await advertised("/v1/ok", {
        authorization: "Bearer ogk_key",
        [OPENGENI_API_CONTRACT_HEADER]: current,
      }),
    ).toBe(current);
    expect(await advertised("/v1/ok", { authorization: "Bearer ogk_key" })).toBe(current);
    expect(await advertised("/v1/ok", { [OPENGENI_API_CONTRACT_HEADER]: OLD })).toBe(current);
    expect(
      await advertised("/v1/ok", {
        cookie: "session=1",
        [OPENGENI_API_CONTRACT_HEADER]: OLD,
      }),
    ).toBe(current);
    expect(
      await advertised(
        "/v1/refused",
        { authorization: "Bearer ogk_key", [OPENGENI_API_CONTRACT_HEADER]: OLD },
        "POST",
      ),
    ).toBe(current);
  });
});
