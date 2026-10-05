import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Manifest = { kind: string; metadata: { name: string }; spec?: { replicas?: number } };

async function render(values: Record<string, unknown>): Promise<Manifest[]> {
  const helm = Bun.which("helm");
  if (!helm) throw new Error("helm is required for chart render tests");
  const root = await mkdtemp(join(tmpdir(), "opengeni-hpa-replicas-"));
  const valuesPath = join(root, "values.json");
  await Bun.write(valuesPath, JSON.stringify(values));
  try {
    const process = Bun.spawn(
      [helm, "template", "hpa-test", resolve(import.meta.dir, ".."), "-f", valuesPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) throw new Error(`helm template failed: ${stderr}`);
    return stdout
      .split(/^---\s*$/mu)
      .map((document) => document.trim())
      .filter(Boolean)
      .map((document) => Bun.YAML.parse(document) as Manifest)
      .filter((manifest) => manifest && typeof manifest.kind === "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function deployment(manifests: Manifest[], name: string): Manifest {
  const found = manifests.find((m) => m.kind === "Deployment" && m.metadata.name === name);
  if (!found) throw new Error(`missing Deployment ${name}`);
  return found;
}

const autoscaled = { enabled: true, minReplicas: 3, maxReplicas: 6 };

describe("HPA-owned Deployment replicas", () => {
  test("a fixed replicaCount is rendered when autoscaling is off", async () => {
    const manifests = await render({
      api: { replicaCount: 5, autoscaling: { enabled: false } },
      worker: { turns: { replicaCount: 7, autoscaling: { enabled: false } } },
    });
    expect(deployment(manifests, "hpa-test-opengeni-api").spec?.replicas).toBe(5);
    expect(deployment(manifests, "hpa-test-opengeni-worker-turns").spec?.replicas).toBe(7);
  });

  // `helm upgrade` would otherwise reset the live Deployment to replicaCount on
  // every upgrade and kill the pods the HPA added. Upgrades keep the live count
  // through `lookup`; offline renders (fresh install, `helm template`) omit it.
  test("replicas is left to the HPA when autoscaling is on", async () => {
    const manifests = await render({
      api: { replicaCount: 2, autoscaling: autoscaled },
      web: { replicaCount: 2, autoscaling: autoscaled },
      worker: {
        control: { replicaCount: 2, autoscaling: autoscaled },
        turns: { replicaCount: 2, autoscaling: autoscaled },
      },
    });
    for (const name of ["api", "web", "worker-control", "worker-turns"]) {
      expect(deployment(manifests, `hpa-test-opengeni-${name}`).spec?.replicas).toBeUndefined();
    }
    expect(
      manifests.filter((m) => m.kind === "HorizontalPodAutoscaler").map((m) => m.metadata.name),
    ).toEqual(
      expect.arrayContaining([
        "hpa-test-opengeni-api",
        "hpa-test-opengeni-web",
        "hpa-test-opengeni-worker-control",
        "hpa-test-opengeni-worker-turns",
      ]),
    );
  });
});
