/**
 * Unit: how the API reads a Site database call's failure (`callSiteDb`).
 */
import { expect, test } from "bun:test";
import { callSiteDb, SiteDbCallError } from "../src/site-sql/gateway";

const CONFIG = { origin: "https://internal.sites.test", secret: "s".repeat(32), timeoutMs: 1000 };
const SITE = "11111111-1111-4111-8111-111111111111";

async function failure(body: unknown, status = 503): Promise<SiteDbCallError> {
  try {
    await callSiteDb(CONFIG, SITE, "run", {}, async () => Response.json(body, { status }));
  } catch (error) {
    if (error instanceof SiteDbCallError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

test("a 503 on a write may have run, unless the gateway says nothing ran", async () => {
  const unknown = await failure({ error: { code: "internal", message: "lost" } });
  expect(unknown).toMatchObject({ status: 503, code: "unavailable", outcomeUnknown: true });
  const refused = await failure({
    error: {
      code: "internal",
      message: "The Site database is moving to its EU location; try again shortly",
      retryable: true,
      outcomeUnknown: false,
    },
  });
  expect(refused).toMatchObject({ status: 503, code: "unavailable", outcomeUnknown: false });
  expect(refused.message).toContain("EU location");
});
