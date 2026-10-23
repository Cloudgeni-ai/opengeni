import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  prepareDeployment,
  hydrateOperator,
} from "../docs/merge-batcher-admin/watchdog-deployment";
import { archive, hydrate } from "../docs/merge-batcher-admin/watchdog-journal";
import { WatchdogCloud } from "../docs/merge-batcher-admin/watchdog-cloud";
import type { RuntimeConfig } from "../docs/merge-batcher-admin/watchdog-provider";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "post-build-")),
    operator = join(root, "image-operator"),
    admin = join(root, "admin");
  await mkdir(operator);
  await mkdir(admin);
  await mkdir(join(admin, "plan"));
  const files = [
    "control.ts",
    "cloud-auth.ts",
    "service-config.ts",
    "service-limits.ts",
    "stopped-reconciliation.ts",
    "watchdog-cloud.ts",
  ];
  const hashes: { [key: string]: string } = {};
  for (const name of files) {
    const body = `export const fixture = ${JSON.stringify(name)};\n`;
    await writeFile(join(operator, name), body);
    hashes[name] = hash(body);
  }
  const manifest = JSON.stringify({
    schema: 1,
    operatorDirectory: operator,
    packagedHashes: hashes,
  });
  await writeFile(join(operator, "source-manifest.json"), manifest);
  const binding = {
    deploymentUid: "new-service",
    image: `registry/image@sha256:${"a".repeat(64)}`,
    activation: "new-activation",
    planDigest: hash("{}"),
    configDigest: "b".repeat(64),
    serviceGeneration: "27",
    revision: "revision-27",
    repository: "Cloudgeni-ai/opengeni",
    stateRef: "refs/heads/batcher-state",
    phaseLimits: { child: { timeoutMs: 910_000, marginMs: 30_000 } },
  };
  const config = {
    binding,
    operatorDirectory: operator,
    operatorManifestDigest: hash(manifest),
    watchdogImage: binding.image,
    serviceResource: "projects/p/locations/l/services/service",
  } as unknown as RuntimeConfig;
  const receipt = { uid: binding.deploymentUid, image: binding.image, uri: "https://service.test" };
  const service = {
    name: config.serviceResource,
    ...receipt,
    generation: "27",
    observedGeneration: "27",
    reconciling: false,
    scaling: { scalingMode: "MANUAL", manualInstanceCount: 0 },
    latestReadyRevision: binding.revision,
    latestCreatedRevision: binding.revision,
    traffic: [{ percent: 100, revision: binding.revision }],
    trafficStatuses: [{ percent: 100, revision: binding.revision }],
    template: {
      fixtureDigest: binding.configDigest,
      containers: [
        {
          image: binding.image,
          env: [
            { name: "BATCHER_RUNTIME_ACTIVATION_ID", value: binding.activation },
            {
              name: "BATCHER_RUNTIME_IDENTITY",
              value: JSON.stringify({
                serviceUid: binding.deploymentUid,
                imageDigest: binding.image,
                configDigest: binding.configDigest,
                serviceGeneration: binding.serviceGeneration,
                revision: binding.revision,
              }),
            },
          ],
        },
      ],
    },
  };
  class Cloud extends WatchdogCloud {
    calls: string[] = [];
    override async request(url: string, init: RequestInit = {}) {
      expect(init.method ?? "GET").toBe("GET");
      this.calls.push(url);
      return Response.json(service);
    }
  }
  const cloud = new Cloud();
  const project = (raw: unknown) => (raw as typeof service).template.fixtureDigest;
  await writeFile(join(admin, "plan/plan.json"), "{}");
  const receiptPath = join(root, "actual-receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipt));
  return {
    root,
    operator,
    admin,
    config,
    cloud,
    service,
    receipt,
    receiptPath,
    project,
    close: () => rm(root, { recursive: true }),
  };
}
test("post-build seed hydrates verified sources privately and journals only mutable receipt, not code", async () => {
  const f = await fixture();
  try {
    await prepareDeployment(f.config, f.admin, f.receiptPath, f.cloud, f.project);
    const original = await archive(f.admin),
      resumed = join(f.root, "resumed");
    await mkdir(resumed);
    await hydrate(resumed, original);
    const operator = await hydrateOperator(f.config, resumed, f.cloud, f.project);
    expect(operator).toBe(join(resumed, "operator"));
    expect(await readFile(join(operator, "control.ts"), "utf8")).toBe(
      await readFile(join(f.operator, "control.ts"), "utf8"),
    );
    expect((await stat(join(operator, "deployment-receipt.json"))).mode & 0o777).toBe(0o600);
    await writeFile(
      join(operator, "deployment-receipt.json"),
      JSON.stringify({ ...f.receipt, stopProof: { fixture: "new durable receipt" } }),
    );
    const next = await archive(resumed);
    expect(Object.keys(next.files)).not.toContain("operator/control.ts");
    expect(Object.keys(next.files)).toContain("operator/deployment-receipt.json");
    const restart = join(f.root, "restart");
    await mkdir(restart);
    await hydrate(restart, next);
    await hydrateOperator(f.config, restart, f.cloud, f.project);
    expect(
      JSON.parse(await readFile(join(restart, "operator/deployment-receipt.json"), "utf8"))
        .stopProof,
    ).toEqual({ fixture: "new durable receipt" });
    expect(await readFile(join(f.root, "actual-receipt.json"), "utf8")).toBe(
      JSON.stringify(f.receipt),
    );
    await expect(
      prepareDeployment(f.config, f.admin, f.receiptPath, f.cloud, f.project),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
test("post-build preparation rejects old image, config, service, revision, activation and live scaling", async () => {
  for (const change of [
    "image",
    "config",
    "uid",
    "revision",
    "activation",
    "running",
    "traffic",
    "reconciling",
  ] as const) {
    const f = await fixture();
    try {
      if (change === "image")
        f.service.template.containers[0]!.image = `registry/image@sha256:${"c".repeat(64)}`;
      if (change === "config") f.service.template.fixtureDigest = "c".repeat(64);
      if (change === "uid") f.service.uid = "old-service";
      if (change === "revision") f.service.latestReadyRevision = "old-revision";
      if (change === "activation")
        f.service.template.containers[0]!.env[0]!.value = "old-activation";
      if (change === "running") f.service.scaling.manualInstanceCount = 1;
      if (change === "traffic") f.service.traffic[0]!.percent = 50;
      if (change === "reconciling") f.service.reconciling = true;
      await expect(
        prepareDeployment(f.config, f.admin, f.receiptPath, f.cloud, f.project),
      ).rejects.toThrow();
      expect(await Bun.file(join(f.admin, "deployment-binding.json")).exists()).toBe(false);
    } finally {
      await f.close();
    }
  }
});
test("hydration rejects tampered manifest, source, seed, initial/current identity and STOP hashes", async () => {
  for (const change of [
    "manifest",
    "source",
    "seed",
    "initial",
    "current",
    "contract",
    "missing",
    "symlink",
  ] as const) {
    const f = await fixture();
    try {
      await prepareDeployment(f.config, f.admin, f.receiptPath, f.cloud, f.project);
      if (change === "manifest") await writeFile(join(f.operator, "source-manifest.json"), "{}");
      if (change === "source") await writeFile(join(f.operator, "control.ts"), "changed");
      if (change === "seed") await writeFile(join(f.admin, "deployment-binding.json"), "{}");
      if (change === "initial")
        await writeFile(join(f.admin, "operator-initial-receipt.json"), "{}");
      if (change === "current")
        await writeFile(
          join(f.admin, "operator/deployment-receipt.json"),
          JSON.stringify({ ...f.receipt, image: "old" }),
        );
      if (change === "contract") await writeFile(join(f.admin, "stop-contract.json"), "{}");
      if (change === "missing") await rm(join(f.admin, "operator/deployment-receipt.json"));
      if (change === "symlink") {
        await rm(join(f.operator, "control.ts"));
        await symlink(f.receiptPath, join(f.operator, "control.ts"));
      }
      await expect(hydrateOperator(f.config, f.admin, f.cloud, f.project)).rejects.toThrow();
      expect(await Bun.file(join(f.admin, "operator/control.ts")).exists()).toBe(false);
    } finally {
      await f.close();
    }
  }
});
