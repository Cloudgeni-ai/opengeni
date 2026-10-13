// Benchmark assets only. The unmodified standard build currently fails its
// eager-graph budget. Never use this path to publish a release or bypass CI.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import config from "../../../apps/web/vite.config";
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { build } = await import(require.resolve("vite"));
await build({
  ...config,
  root: resolve(import.meta.dir, "../../../apps/web"),
  configFile: false,
  plugins: config.plugins?.filter(
    (plugin) => !(plugin && "name" in plugin && plugin.name === "opengeni-eager-graph"),
  ),
});
