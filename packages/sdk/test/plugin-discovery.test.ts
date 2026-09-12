import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { pluginMcpUnavailableReason } from "../src/index";
import { pluginMcpUnavailableReason as canonical } from "@opengeni/contracts/plugin-discovery";

test("public plugin endpoint compatibility preserves the canonical policy", () => {
  expect(pluginMcpUnavailableReason).toBe(canonical);
  expect(
    pluginMcpUnavailableReason({ endpoint: "https://example.com/mcp", transport: "http" }),
  ).toBeNull();
  for (const server of [
    { endpoint: null },
    { endpoint: "https://example.com/mcp", transport: "stdio" },
    { endpoint: "http://example.com/mcp" },
    { endpoint: "https://example.com/{tenant}/mcp" },
    { endpoint: "https://example.com/mcp", requiresConfiguration: true },
    { endpoint: "https://user:password@example.com/mcp" },
  ])
    expect(pluginMcpUnavailableReason(server)).not.toBeNull();
});

test("plugin discovery contracts entry stays free of schema dependencies", async () => {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(import.meta.resolve("@opengeni/contracts/plugin-discovery"))],
    target: "browser",
    minify: true,
  });
  expect(built.success).toBe(true);
  expect(built.outputs).toHaveLength(1);
  expect(built.outputs[0]!.size).toBeLessThan(2000);
});
