/** Post-build receipt binding and private operator hydration. No deployment,
 * IAM or runtime mutation. Never synthesize STOP proof or an image self-digest. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WatchdogCloud } from "./watchdog-cloud";
import type { RuntimeConfig } from "./watchdog-provider";
const files = [
  "control.ts",
  "cloud-auth.ts",
  "service-config.ts",
  "service-limits.ts",
  "stopped-reconciliation.ts",
  "watchdog-cloud.ts",
] as const;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
type Json = { [key: string]: any };
type Projection = (raw: unknown) => string;
type PostBuild = {
  schema: 1;
  binding: RuntimeConfig["binding"];
  serviceResource: string;
  manifestDigest: string;
  initialReceiptDigest: string;
};
async function regular(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Regular pinned operator file required");
  return readFile(path);
}
async function projection(config: RuntimeConfig): Promise<Projection> {
  if (!(await realpath(config.coreModule)).startsWith("/app/"))
    throw Error("Core projection outside image");
  if (hash(await regular(config.coreModule)) !== config.coreModuleDigest)
    throw Error("Core projection source changed");
  const module = await import(config.coreModule);
  if (typeof module.serviceConfigurationDigest !== "function")
    throw Error("Versioned core configuration projection required");
  return module.serviceConfigurationDigest;
}
async function sources(config: RuntimeConfig) {
  const directory = await realpath(config.operatorDirectory);
  if (directory !== resolve(config.operatorDirectory))
    throw Error("Operator directory symlink refused");
  const bytes = await regular(join(directory, "source-manifest.json"));
  if (
    !/^[a-f0-9]{64}$/.test(config.operatorManifestDigest) ||
    hash(bytes) !== config.operatorManifestDigest
  )
    throw Error("Packaged operator manifest changed");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    manifest.schema !== 1 ||
    manifest.operatorDirectory !== config.operatorDirectory ||
    canonical(Object.keys(manifest.packagedHashes ?? {}).sort()) !== canonical([...files].sort())
  )
    throw Error("Incomplete packaged operator manifest");
  const result = new Map<string, Buffer>();
  for (const name of files) {
    const body = await regular(join(directory, name));
    if (hash(body) !== manifest.packagedHashes[name])
      throw Error("Packaged operator source mismatch");
    result.set(name, body);
  }
  return { result, manifest };
}
function validateService(config: RuntimeConfig, raw: Json, receipt: Json, project: Projection) {
  const b = config.binding,
    revision = (value: unknown) => (typeof value === "string" ? value.split("/").at(-1) : null);
  const count = raw.scaling?.manualInstanceCount ?? 0;
  if (
    raw.name !== config.serviceResource ||
    raw.uid !== b.deploymentUid ||
    receipt.uid !== b.deploymentUid ||
    receipt.image !== b.image ||
    config.watchdogImage !== b.image ||
    receipt.uri !== raw.uri ||
    typeof receipt.uri !== "string" ||
    !receipt.uri.startsWith("https://") ||
    raw.reconciling ||
    !/^\d+$/.test(String(raw.generation)) ||
    String(raw.observedGeneration) !== String(raw.generation) ||
    raw.scaling?.scalingMode !== "MANUAL" ||
    ![0, 1].includes(count) ||
    (count === 1
      ? String(raw.generation) !== b.serviceGeneration
      : BigInt(raw.generation) < BigInt(b.serviceGeneration)) ||
    raw.template?.containers?.length !== 1 ||
    raw.template.containers[0].image !== b.image ||
    project(raw) !== b.configDigest ||
    revision(raw.latestReadyRevision) !== revision(b.revision) ||
    revision(raw.latestCreatedRevision) !== revision(b.revision)
  )
    throw Error("Post-build service identity/configuration mismatch");
  for (const traffic of [raw.traffic, raw.trafficStatuses])
    if (
      !Array.isArray(traffic) ||
      traffic.length !== 1 ||
      traffic[0].percent !== 100 ||
      traffic[0].tag ||
      (traffic[0].revision && revision(traffic[0].revision) !== revision(b.revision))
    )
      throw Error("Post-build traffic mismatch");
  if (revision(raw.trafficStatuses[0].revision) !== revision(b.revision))
    throw Error("Observed revision missing");
  const env = raw.template.containers[0].env;
  const identity = Array.isArray(env)
    ? env.filter((item: Json) => item.name === "BATCHER_RUNTIME_IDENTITY")
    : [];
  const activation = Array.isArray(env)
    ? env.filter((item: Json) => item.name === "BATCHER_RUNTIME_ACTIVATION_ID")
    : [];
  if (
    identity.length !== 1 ||
    activation.length !== 1 ||
    activation[0].value !== b.activation ||
    canonical(JSON.parse(identity[0].value)) !==
      canonical({
        serviceUid: b.deploymentUid,
        imageDigest: b.image,
        configDigest: b.configDigest,
        serviceGeneration: b.serviceGeneration,
        revision: b.revision,
      })
  )
    throw Error("Post-build runtime activation/identity mismatch");
}
/** Called only after build and actual stopped deployment. Reads provider; writes
 * create-only local seed files. Receipt supplied by operator, never fabricated. */
export async function prepareDeployment(
  config: RuntimeConfig,
  admin: string,
  receiptPath: string,
  cloud = new WatchdogCloud(),
  project?: Projection,
) {
  const { manifest } = await sources(config);
  const receiptBytes = await regular(receiptPath),
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  const service = await cloud.json<Json>(`https://run.googleapis.com/v2/${config.serviceResource}`);
  validateService(config, service, receipt, project ?? (await projection(config)));
  if ((service.scaling.manualInstanceCount ?? 0) !== 0)
    throw Error("Post-build seed preparation requires stopped service");
  const planBytes = await regular(join(admin, "plan/plan.json"));
  if (hash(planBytes) !== config.binding.planDigest) throw Error("Saved plan mismatch");
  const binding: PostBuild = {
    schema: 1,
    binding: config.binding,
    serviceResource: config.serviceResource,
    manifestDigest: config.operatorManifestDigest,
    initialReceiptDigest: hash(receiptBytes),
  };
  await mkdir(join(admin, "operator"), { mode: 0o700 });
  const outputs = {
    "deployment-binding.json": JSON.stringify(binding),
    "operator-initial-receipt.json": receiptBytes,
    "operator/deployment-receipt.json": receiptBytes,
    "stop-contract.json": JSON.stringify({
      schemaVersion: 1,
      directory: config.operatorDirectory,
      sources: Object.fromEntries(
        files
          .filter((name) => name !== "watchdog-cloud.ts")
          .map((name) => [name, manifest.packagedHashes[name]]),
      ),
      deployment: { uid: receipt.uid, image: receipt.image, uri: receipt.uri },
    }),
  };
  for (const [name, body] of Object.entries(outputs))
    await writeFile(join(admin, name), body, { flag: "wx", mode: 0o600 });
}
/** Hydrate executable bytes from the qualified image, not from the mutable
 * journal. Receipt updates alone are journalled; sources are always rehashed. */
export async function hydrateOperator(
  config: RuntimeConfig,
  admin: string,
  cloud = new WatchdogCloud(),
  project?: Projection,
): Promise<string> {
  const { result, manifest } = await sources(config);
  const post = JSON.parse(
    (await regular(join(admin, "deployment-binding.json"))).toString("utf8"),
  ) as PostBuild;
  const initial = await regular(join(admin, "operator-initial-receipt.json"));
  if (
    post.schema !== 1 ||
    canonical(post.binding) !== canonical(config.binding) ||
    post.serviceResource !== config.serviceResource ||
    post.manifestDigest !== config.operatorManifestDigest ||
    post.initialReceiptDigest !== hash(initial)
  )
    throw Error("Post-build seed binding mismatch");
  const directory = join(admin, "operator");
  const receipt = JSON.parse(
    (await regular(join(directory, "deployment-receipt.json"))).toString("utf8"),
  );
  const original = JSON.parse(initial.toString("utf8"));
  if (
    canonical([receipt.uid, receipt.image, receipt.uri]) !==
    canonical([original.uid, original.image, original.uri])
  )
    throw Error("Journal operator identity changed");
  const contract = JSON.parse((await regular(join(admin, "stop-contract.json"))).toString("utf8"));
  if (
    contract.schemaVersion !== 1 ||
    contract.directory !== config.operatorDirectory ||
    canonical(contract.sources) !==
      canonical(
        Object.fromEntries(
          files
            .filter((name) => name !== "watchdog-cloud.ts")
            .map((name) => [name, manifest.packagedHashes[name]]),
        ),
      ) ||
    canonical(contract.deployment) !==
      canonical({ uid: receipt.uid, image: receipt.image, uri: receipt.uri })
  )
    throw Error("STOP source/deployment binding mismatch");
  validateService(
    config,
    await cloud.json<Json>(`https://run.googleapis.com/v2/${config.serviceResource}`),
    receipt,
    project ?? (await projection(config)),
  );
  for (const [name, body] of result)
    await writeFile(join(directory, name), body, { flag: "wx", mode: 0o600 });
  return directory;
}
if (import.meta.main) {
  const [command, configPath, admin, receipt] = process.argv.slice(2);
  if (command !== "prepare" || !configPath || !admin || !receipt)
    throw Error("Usage: watchdog-deployment.ts prepare CONFIG ADMIN_DIR ACTUAL_OPERATOR_RECEIPT");
  await prepareDeployment(JSON.parse(await readFile(configPath, "utf8")), admin, receipt);
  console.log("Post-build seed bound; no live changes");
}
