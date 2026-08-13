import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePinnedAgentBrowserBinary } from "../src/binary";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(packageRoot, "dist");
const platform = targetPlatform(process.env.OPENGENI_BROWSERD_TARGET_PLATFORM);
const architecture = targetArchitecture(process.env.OPENGENI_BROWSERD_TARGET_ARCH);
const musl = targetMusl(process.env.OPENGENI_BROWSERD_TARGET_MUSL);
const outputPath = join(
  outputDirectory,
  process.env.OPENGENI_BROWSERD_AGENT_BROWSER_OUTPUT ??
    (platform === "win32" ? "agent-browser.exe" : "agent-browser"),
);
const source = await resolvePinnedAgentBrowserBinary({
  platform,
  architecture,
  ...(musl === undefined ? {} : { musl }),
});

await mkdir(outputDirectory, { recursive: true });
await copyFile(source.path, outputPath);
if (platform !== "win32") await chmod(outputPath, 0o755);

function targetPlatform(value: string | undefined): NodeJS.Platform {
  if (!value) return process.platform;
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  throw new Error(`Unsupported target platform ${value}`);
}

function targetArchitecture(value: string | undefined): string {
  if (!value) return process.arch;
  if (value === "arm64" || value === "x64") return value;
  throw new Error(`Unsupported target architecture ${value}`);
}

function targetMusl(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`OPENGENI_BROWSERD_TARGET_MUSL must be true or false; received ${value}`);
}
