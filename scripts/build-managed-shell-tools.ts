import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MANAGED_SHELL_TOOLS_ARCHES,
  managedShellToolsAssetName,
  managedShellToolsFromDirectory,
} from "../packages/runtime/src/sandbox/shell-tools";

/**
 * Writes the worker release's rg and jq bundles for managed sandboxes from a
 * `scripts/fetch-shell-tools.ts` output directory. Without one (a local build)
 * the worker carries none and boxes keep the tools their image has.
 */
export async function writeManagedShellTools(
  outdir: string,
  fetched: string | undefined,
): Promise<void> {
  if (!fetched) {
    console.log("OPENGENI_SHELL_TOOLS_DIR is not set; the worker ships without rg and jq bundles");
    return;
  }
  const tools = managedShellToolsFromDirectory(resolve(fetched));
  await mkdir(outdir, { recursive: true });
  for (const arch of MANAGED_SHELL_TOOLS_ARCHES) {
    await writeFile(join(outdir, managedShellToolsAssetName(arch)), tools[arch].bytes);
  }
}

if (import.meta.main) {
  await writeManagedShellTools(resolve(process.argv[2]!), process.argv[3]);
}
