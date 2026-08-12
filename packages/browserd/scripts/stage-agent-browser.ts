import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePinnedAgentBrowserBinary } from "../src/binary";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(packageRoot, "dist");
const outputPath = join(
  outputDirectory,
  process.platform === "win32" ? "agent-browser.exe" : "agent-browser",
);
const source = await resolvePinnedAgentBrowserBinary();

await mkdir(outputDirectory, { recursive: true });
await copyFile(source.path, outputPath);
if (process.platform !== "win32") await chmod(outputPath, 0o755);
