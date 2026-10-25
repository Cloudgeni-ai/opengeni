/** Provider wrapper around unchanged OFF; no automatic claim recovery or ON. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { off } from "./off";
import { tick } from "./minimal-watchdog";

type Cloud = {
  api(url: string, method?: string, body?: unknown): Promise<any>;
  identityToken(audience: string): Promise<string>;
};
export type Configuration = {
  service: string;
  adminDirectory: string;
  claimBucket: string;
  claimObject: string;
  activationId: string;
  planSha256: string;
  operatorDirectory?: "/opt/batcher-operator";
  contractSha256?: string;
};
const files = [
  "control.ts",
  "cloud-auth.ts",
  "service-config.ts",
  "service-limits.ts",
  "stopped-reconciliation.ts",
];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export type Dependencies = {
  read(path: string): Promise<string>;
  loadCloud(path: string): Promise<Cloud>;
  off(
    path: string,
    optIn: string,
    expectedContractSha256?: string,
    expectedPlanSha256?: string,
  ): Promise<void>;
  request: typeof fetch;
  now(): number;
  record(event: unknown): void;
};
const defaults: Dependencies = {
  read: (path) => readFile(path, "utf8"),
  loadCloud: (path) => import(path),
  off,
  request: fetch,
  now: Date.now,
  record: (event) => console.log(JSON.stringify(event)),
};
export async function run(config: Configuration, deps = defaults): Promise<string> {
  if (
    !/^projects\/cloudgeni-gecko\/locations\/europe-west1\/services\/[a-z0-9-]+$/.test(
      config.service,
    ) ||
    config.adminDirectory !== "/work/admin" ||
    !/^[a-z0-9][a-z0-9.-]{2,62}$/.test(config.claimBucket) ||
    !/^[a-f0-9-]{36}$/.test(config.activationId) ||
    !/^[a-f0-9]{64}$/.test(config.planSha256)
  )
    throw Error("Invalid pinned watchdog configuration");
  if (config.claimObject !== `minimal-watchdog/${config.activationId}/${config.planSha256}/claim`)
    throw Error("Claim must bind exact saved plan");
  const plan = await deps.read(join(config.adminDirectory, "plan/plan.json"));
  if (sha(plan) !== config.planSha256) throw Error("Saved plan changed");
  const contractBytes = await deps.read(join(config.adminDirectory, "stop-contract.json"));
  const contract = JSON.parse(contractBytes);
  const portable = config.operatorDirectory !== undefined;
  if (
    portable &&
    (config.operatorDirectory !== "/opt/batcher-operator" ||
      !/^[a-f0-9]{64}$/.test(config.contractSha256 ?? "") ||
      sha(contractBytes) !== config.contractSha256 ||
      contract.receiptDirectory !== "/work/operator")
  )
    throw Error("Pinned image operator contract changed");
  if (
    contract.schemaVersion !== 1 ||
    contract.directory !== (config.operatorDirectory ?? "/work/operator")
  )
    throw Error("Unexpected OFF package");
  for (const file of files) {
    if (sha(await deps.read(join(contract.directory, file))) !== contract.sources?.[file])
      throw Error("Reviewed OFF operator changed");
  }
  const cloud = await deps.loadCloud(join(contract.directory, "cloud-auth.ts"));
  const target = contract.deployment;
  if (
    typeof target?.uid !== "string" ||
    !target.uid ||
    !/^https:\/\/[a-z0-9.-]+\.run\.app$/.test(target.uri ?? "") ||
    !/@sha256:[a-f0-9]{64}$/.test(target.image ?? "")
  )
    throw Error("Missing pinned deployment identity");
  return tick({
    now: deps.now,
    async verifyBinding() {
      const live = await cloud.api(`https://run.googleapis.com/v2/${config.service}`);
      if (
        live.uid !== target.uid ||
        live.uri !== target.uri ||
        live.template?.containers?.[0]?.image !== target.image ||
        live.reconciling ||
        String(live.observedGeneration) !== String(live.generation)
      )
        throw Error("Live service no longer matches OFF binding");
    },
    async status() {
      const token = await cloud.identityToken(target.uri);
      const response = await deps.request(`${target.uri}/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw Error("Status unavailable");
      return response.json();
    },
    async claim() {
      // JSON-data media upload with generation precondition. No expiry,
      // deletion or automatic unlock: crash/timeout after this boundary holds.
      try {
        await cloud.api(
          `https://storage.googleapis.com/upload/storage/v1/b/${config.claimBucket}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(config.claimObject)}`,
          "POST",
          {
            planSha256: config.planSha256,
            service: config.service,
            activationId: config.activationId,
            claimedAt: new Date(deps.now()).toISOString(),
          },
        );
        return true;
      } catch (error) {
        if ((error as { status?: number }).status === 412) return false;
        throw Error("Claim outcome unavailable; no OFF replay", { cause: error });
      }
    },
    async off() {
      await deps.off(
        config.adminDirectory,
        "--apply-after-go",
        config.contractSha256,
        config.planSha256,
      );
    },
    async record(event) {
      deps.record({ event: "minimal-watchdog", ...event, planSha256: config.planSha256 });
    },
  });
}
if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path) throw Error("Configuration path required");
    const outcome = await run(JSON.parse(await readFile(path, "utf8")));
    if (outcome === "held") process.exitCode = 1;
  } catch {
    console.error(
      JSON.stringify({
        event: "minimal-watchdog",
        outcome: "held",
        reason: "provider-or-binding-failure",
      }),
    );
    process.exitCode = 1;
  }
}
