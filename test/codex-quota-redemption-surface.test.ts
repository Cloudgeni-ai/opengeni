import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");

// The organization MCP catalog lists every route an agent acting as a person
// may call, including this one: an owner decision allows reset
// credits under Full access. The route still requires the person, in their
// browser or through a verified agent acting as them; nothing else may name it.
const ORGANIZATION_MCP_CATALOG = "apps/api/src/mcp/action-catalog.gen.ts";

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({
    cwd: join(repo, root),
  })) {
    files.push(join(root, path));
  }
  return files.sort();
}

describe("Codex quota human-only reset-credit surface", () => {
  test("SDK, MCP, workers, scheduled/background domains, and published React expose no redemption", async () => {
    const roots = [
      "packages/sdk/src",
      "packages/react/src",
      "apps/api/src/mcp",
      "apps/worker/src",
      "packages/core/src/domain",
      "packages/runtime/src",
    ];
    const forbidden = [
      "consumeCodexRateLimitResetCredit",
      "/reset-credits/prepare",
      "/reset-credits/redeem",
      "prepareCodexResetRedemption",
      "redeemCodexResetCredit",
    ];
    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        if (file === ORGANIZATION_MCP_CATALOG) continue;
        const content = await readFile(join(repo, file), "utf8");
        for (const marker of forbidden) {
          expect(content.includes(marker), `${file} must not contain ${marker}`).toBe(false);
        }
      }
    }

    // Scheduled/background API code lives outside the MCP/core roots. Scan the
    // entire API source tree and allow the irreversible markers only in the one
    // reviewed human route adapter.
    for (const file of await sourceFiles("apps/api/src")) {
      if (file === "apps/api/src/routes/codex.ts" || file === ORGANIZATION_MCP_CATALOG) continue;
      const content = await readFile(join(repo, file), "utf8");
      for (const marker of forbidden) {
        expect(content.includes(marker), `${file} must not contain ${marker}`).toBe(false);
      }
    }
  });

  test("the mutation exists only at the API route and bespoke browser API seam", async () => {
    const route = await readFile(join(repo, "apps/api/src/routes/codex.ts"), "utf8");
    const browser = await readFile(join(repo, "apps/web/src/api.ts"), "utf8");
    expect(route).toContain("consumeCodexRateLimitResetCredit");
    expect(route).toContain("/reset-credits/prepare");
    expect(route).toContain("/reset-credits/redeem");
    expect(browser).toContain("prepareCodexResetRedemption");
    expect(browser).toContain("redeemCodexResetCredit");
    expect(browser).toContain('credentials: "include"');
    // The dedicated browser helper must not borrow the generic authHeaders()
    // path that can add a configured bearer/deployment key.
    const helper = browser.slice(browser.indexOf("async function managedBrowserMutation"));
    expect(helper).not.toContain("authHeaders()");
  });
});
