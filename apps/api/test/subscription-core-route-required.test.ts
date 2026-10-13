// A provider whose legacy runtime was deleted serves only `core`. Without its
// receipt the route reader answers `legacy` before resolving the
// organization; the refusal must still run authorization first, exactly as
// under maintenance, so a stranger cannot learn the provider's state.
import { describe, expect, mock, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import * as realDb from "@opengeni/db";

let route: "legacy" | "maintenance" | "core" = "legacy";
mock.module("@opengeni/db", () => ({
  ...realDb,
  readSubscriptionCoreProviderRouteForRequest: mock(
    async (_db: unknown, _provider: string, accountId: () => Promise<string>) => {
      // The real reader resolves the organization only after a receipt.
      if (route !== "legacy") await accountId();
      return route;
    },
  ),
}));

const { requireSubscriptionCoreRoute } = await import("../src/routes/subscription-pool-core");
const { ApiHttpError } = await import("../src/http/api-error");
const { SUBSCRIPTION_CORE_CUTOVER_DISABLED } = await import("../src/routes/subscription-core-http");

const deps = { db: {} } as never;
const unauthorized = async (): Promise<string> => {
  throw new HTTPException(401, { message: "unauthorized" });
};

async function outcome(accountId: () => Promise<string>): Promise<unknown> {
  return await requireSubscriptionCoreRoute(deps, "xai", "SuperGrok", accountId).catch(
    (error: unknown) => error,
  );
}

describe("requireSubscriptionCoreRoute", () => {
  for (const current of ["legacy", "maintenance"] as const) {
    test(`on ${current}, authorization runs before the typed maintenance refusal`, async () => {
      route = current;
      const denied = await outcome(unauthorized);
      expect(denied).toBeInstanceOf(HTTPException);
      expect(denied).not.toBeInstanceOf(ApiHttpError);
      expect((denied as HTTPException).status).toBe(401);

      const refused = await outcome(async () => "organization");
      expect(refused).toBeInstanceOf(ApiHttpError);
      expect((refused as InstanceType<typeof ApiHttpError>).status).toBe(503);
      expect((refused as InstanceType<typeof ApiHttpError>).details).toEqual({
        reason: SUBSCRIPTION_CORE_CUTOVER_DISABLED,
      });
    });
  }

  test("on core, the route is served", async () => {
    route = "core";
    expect(await outcome(async () => "organization")).toBe("core");
  });
});
