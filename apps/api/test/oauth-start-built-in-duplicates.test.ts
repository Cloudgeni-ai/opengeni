import { describe, expect, test } from "bun:test";
import { OrganizationIntegrationDeniedError } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import { assertDuplicatedBuiltInIntegrationAllowed } from "../src/integrations/oauth-client";

const scope = { accountId: "account", workspaceId: "workspace" };
const GMAIL_MCP = "https://gmailmcp.googleapis.com/mcp/v1";

/** An organization policy that allows only `allowed`, checked as the real fence checks it. */
function policy(allowed: readonly string[]) {
  const checked: string[][] = [];
  const acquire = (async (
    _db: unknown,
    _scope: unknown,
    keys: readonly string[],
    run: (tx: unknown) => Promise<unknown>,
  ) => {
    checked.push([...keys]);
    for (const key of keys)
      if (!allowed.includes(key)) throw new OrganizationIntegrationDeniedError();
    return await run({});
  }) as never;
  return { acquire, checked };
}

describe("custom MCP sign-in to a built-in integration's endpoint", () => {
  test("is refused with the built-in's plain message while the organization turned it off", async () => {
    const { acquire, checked } = policy(["custom:mcp"]);
    const refusal = await assertDuplicatedBuiltInIntegrationAllowed(
      {} as never,
      scope,
      GMAIL_MCP,
      undefined,
      acquire,
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(HTTPException);
    expect((refusal as HTTPException).status).toBe(403);
    expect((refusal as HTTPException).message).toBe(
      "Gmail is turned off for this organization, so it can't be connected here. An organization admin can turn it on in the organization's integration settings.",
    );
    expect(checked).toEqual([["gmail"]]);
  });

  test("goes ahead when the organization allows the built-in", async () => {
    const { acquire, checked } = policy(["custom:mcp", "gmail"]);
    await assertDuplicatedBuiltInIntegrationAllowed({} as never, scope, GMAIL_MCP, null, acquire);
    expect(checked).toEqual([["gmail"]]);
  });

  test("other endpoints, and the built-in's own sign-in, are not checked here", async () => {
    const { acquire, checked } = policy([]);
    await assertDuplicatedBuiltInIntegrationAllowed(
      {} as never,
      scope,
      "https://mcp.linear.app/mcp",
      undefined,
      acquire,
    );
    await assertDuplicatedBuiltInIntegrationAllowed(
      {} as never,
      scope,
      "https://drivemcp.googleapis.com/mcp/v1",
      "google-drive",
      acquire,
    );
    expect(checked).toEqual([]);
  });

  test("other failures are not reported as turned off", async () => {
    const failure = new Error("database unavailable");
    const acquire = (async () => {
      throw failure;
    }) as never;
    expect(
      await assertDuplicatedBuiltInIntegrationAllowed(
        {} as never,
        scope,
        GMAIL_MCP,
        undefined,
        acquire,
      ).catch((error: unknown) => error),
    ).toBe(failure);
  });
});
