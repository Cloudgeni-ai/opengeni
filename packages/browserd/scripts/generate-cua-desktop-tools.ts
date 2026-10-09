import { CUA_DESKTOP_TOOLS } from "@opengeni/contracts";
import { createCuaRuntime } from "../src/cua/sdk";

// Release generation reads only the bundled driver's static tool inventory.
// No app discovery, screenshots, native input, or permission prompts.
const runtime = await createCuaRuntime();
try {
  const catalog = JSON.parse(await runtime.listToolsJson());
  const admitted = new Set(CUA_DESKTOP_TOOLS.map((tool) => tool.name));
  const tools = catalog.tools.filter((tool: { name: string }) => admitted.has(tool.name));
  if (tools.length !== admitted.size) throw new Error("CUA desktop inventory is incomplete");
  await Bun.write(
    new URL("../../contracts/src/cua-desktop-tools.gen.json", import.meta.url),
    JSON.stringify(tools, null, 2) + "\n",
  );
  console.log(`Generated ${tools.length} upstream desktop tool definitions`);
} finally {
  await runtime.shutdown();
  runtime.uniffiDestroy();
}
