/** Durable snapshots around reviewed OFF stages; no automatic CAS retry. */
import { lstat, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ObjectStore, WatchdogCloud } from "./watchdog-cloud";
export type Archive = { schema: 1; files: { [path: string]: string } };
function allowed(path: string): boolean {
  return (
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    !path.includes("\\") &&
    ([
      "stop-contract.json",
      "deployment-binding.json",
      "operator-initial-receipt.json",
      "operator/deployment-receipt.json",
    ].includes(path) ||
      path.startsWith("plan/") ||
      /^off\.[^/]+\//.test(path)) &&
    !path.split("/").some((part) => part.endsWith("-lock") || part === "off-lock")
  );
}
export async function archive(directory: string): Promise<Archive> {
  const files: Archive["files"] = {};
  async function walk(relative: string) {
    for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw Error("Journal refuses symlinks");
      if (item.isDirectory()) {
        if (item.name.endsWith("-lock") || item.name === "off-lock") continue;
        if (
          path === "operator" ||
          path === "plan" ||
          path.startsWith("plan/") ||
          /^off\.[^/]+(?:\/|$)/.test(path)
        )
          await walk(path);
      } else if (allowed(path))
        files[path] = (await readFile(join(directory, path))).toString("base64");
    }
  }
  await walk("");
  return { schema: 1, files };
}
export async function hydrate(directory: string, value: Archive): Promise<void> {
  if (value.schema !== 1 || !value.files || typeof value.files !== "object")
    throw Error("Invalid OFF journal");
  // Caller supplies a new empty private directory. No saved file may overwrite it.
  for (const [path, body] of Object.entries(value.files)) {
    if (!allowed(path) || typeof body !== "string") throw Error("Invalid OFF journal path");
    await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, path), Buffer.from(body, "base64"), {
      flag: "wx",
      mode: 0o600,
    });
  }
}
export type JournalConfig = {
  bucket: string;
  object: string;
  generation: string;
  directory: string;
};
export async function checkpoint(configPath: string, cloud = new WatchdogCloud()): Promise<void> {
  const stat = await lstat(configPath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("Journal configuration must be a regular file");
  const config = JSON.parse(await readFile(configPath, "utf8")) as JournalConfig;
  const store = new ObjectStore(cloud, config.bucket);
  const generation = await store.cas(
    config.object,
    config.generation,
    await archive(config.directory),
  );
  if (!generation) throw Error("OFF journal CAS lost; stop without another provider write");
  await writeFile(configPath, JSON.stringify({ ...config, generation }), { mode: 0o600 });
}
if (import.meta.main) {
  const config = process.env.BATCHER_ADMIN_JOURNAL_CONFIG;
  if (!config) throw Error("Pinned journal configuration missing");
  await checkpoint(config);
}
