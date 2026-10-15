import { CUA_DESKTOP_TOOLS } from "@opengeni/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCuaRuntime } from "../src/cua/sdk";

// Release generation reads only the bundled driver's static tool inventory.
// No app discovery, screenshots, native input, or permission prompts.
// Run it on each platform: macOS defines the admitted set; Linux and Windows
// publish their own schemas for that set and may omit tools they lack.
const suffix =
  process.platform === "linux" ? ".linux" : process.platform === "win32" ? ".windows" : "";
const directory =
  process.platform === "linux" ? await mkdtemp(join(tmpdir(), "cua-catalog-")) : null;
const runtime = await createCuaRuntime(
  directory ? { ...process.env, HOME: directory, XDG_RUNTIME_DIR: directory } : process.env,
);
try {
  const catalog = JSON.parse(await runtime.listToolsJson());
  const admitted = new Set(CUA_DESKTOP_TOOLS.map((tool) => tool.name));
  const tools = catalog.tools.filter((tool: { name: string }) => admitted.has(tool.name));
  const missing = [...admitted].filter(
    (name) => !tools.some((tool: { name: string }) => tool.name === name),
  );
  if (missing.length && !suffix) throw new Error("CUA desktop inventory is incomplete");
  if (missing.length) console.log(`This platform omits: ${missing.join(", ")}`);
  await Bun.write(
    new URL(`../../contracts/src/cua-desktop-tools${suffix}.gen.json`, import.meta.url),
    JSON.stringify(tools, null, 2) + "\n",
  );
  console.log(`Generated ${tools.length} upstream desktop tool definitions`);
} finally {
  await runtime.shutdown();
  runtime.uniffiDestroy();
  if (directory) await rm(directory, { recursive: true, force: true });
}
