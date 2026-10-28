/** Job-only entrypoint: immutable revision env pins config; image pins executable code. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { run, type Configuration } from "./minimal-watchdog-provider";
import { eventFor, exitCode, parseGrace, type Outcome } from "./minimal-watchdog";
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
function pinnedConfig(serialized: string, expectedDigest: string): Configuration {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || digest(serialized) !== expectedDigest)
    throw Error("Immutable Job config digest mismatch");
  const config = JSON.parse(serialized);
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw Error("Invalid Job config");
  return config as Configuration;
}
export async function verifyImageInputs(
  serialized: string,
  expectedDigest: string,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<Configuration> {
  const config = pinnedConfig(serialized, expectedDigest);
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
export async function runImage(
  serialized: string,
  expectedDigest: string,
  deps: {
    read(path: string): Promise<string>;
    now(): number;
    run(config: Configuration): Promise<Outcome>;
    record(event: unknown): void;
  } = {
    read: (path) => readFile(path, "utf8"),
    now: Date.now,
    run,
    record: (event) => console.log(JSON.stringify(event)),
  },
): Promise<number> {
  let graceUntil: number | undefined;
  try {
    // Only immutable, authenticated configuration can suppress an image failure.
    const pinned = pinnedConfig(serialized, expectedDigest);
    const grace = parseGrace(pinned.graceUntil, deps.now());
    graceUntil = grace.until;
    if (grace.invalid)
      deps.record({ event: "minimal-watchdog", ...eventFor("invalid-grace", deps.now()) });
    const config = await verifyImageInputs(serialized, expectedDigest, deps.read);
    // Invalid optional grace must not break healthy observation or warn twice.
    delete config.graceUntil;
    if (graceUntil !== undefined) config.graceUntil = graceUntil;
    return exitCode(await deps.run(config));
  } catch {
    const event = eventFor("immutable-image-binding-failed", deps.now(), graceUntil);
    deps.record({ event: "minimal-watchdog", ...event });
    return exitCode(event.outcome);
  }
}
if (import.meta.main) {
  process.exitCode = await runImage(
    process.env.BATCHER_WATCHDOG_CONFIG_JSON ?? "",
    process.env.BATCHER_WATCHDOG_CONFIG_SHA256 ?? "",
  );
}
