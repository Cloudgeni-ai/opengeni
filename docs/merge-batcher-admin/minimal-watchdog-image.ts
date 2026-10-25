/** Job-only entrypoint: immutable revision env pins config; image pins executable code. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { run, type Configuration } from "./minimal-watchdog-provider";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const imageDirectory = "/opt/batcher-operator";
const names = [
  "control.ts",
  "cloud-auth.ts",
  "service-config.ts",
  "service-limits.ts",
  "stopped-reconciliation.ts",
  "stopped-lineage.ts",
];
export async function verifyImageInputs(
  serialized: string,
  expectedDigest: string,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<Configuration> {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || digest(serialized) !== expectedDigest)
    throw Error("Immutable Job config digest mismatch");
  const config = JSON.parse(serialized) as Configuration;
  if (
    config.operatorDirectory !== imageDirectory ||
    config.adminDirectory !== "/work/admin" ||
    !/^[a-f0-9]{64}$/.test(config.contractSha256 ?? "")
  )
    throw Error("Image operator and contract must be pinned");
  const manifest = JSON.parse(await read(`${imageDirectory}/source-manifest.json`));
  const bytes = await read("/work/admin/stop-contract.json");
  if (digest(bytes) !== config.contractSha256) throw Error("STOP contract digest mismatch");
  const contract = JSON.parse(bytes);
  if (contract.directory !== imageDirectory || contract.receiptDirectory !== "/work/operator")
    throw Error("Operator code must be image-backed");
  if (
    Object.keys(manifest.sources ?? {})
      .sort()
      .join() !== [...names].sort().join()
  )
    throw Error("Image source manifest incomplete");
  for (const name of names) {
    const hash = manifest.sources[name];
    if (
      !/^[a-f0-9]{64}$/.test(hash ?? "") ||
      contract.sources?.[name] !== hash ||
      digest(await read(`${imageDirectory}/${name}`)) !== hash
    )
      throw Error(`Image operator source mismatch: ${name}`);
  }
  return config;
}
if (import.meta.main) {
  try {
    const config = await verifyImageInputs(
      process.env.BATCHER_WATCHDOG_CONFIG_JSON ?? "",
      process.env.BATCHER_WATCHDOG_CONFIG_SHA256 ?? "",
    );
    const outcome = await run(config);
    if (outcome === "held") process.exitCode = 1;
  } catch {
    console.error(
      JSON.stringify({
        event: "minimal-watchdog",
        outcome: "held",
        reason: "immutable-image-binding-failed",
      }),
    );
    process.exitCode = 1;
  }
}
