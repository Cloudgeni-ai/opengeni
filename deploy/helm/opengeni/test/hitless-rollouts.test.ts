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

function container(manifest: Manifest): Record<string, any> {
  return (manifest.spec as any).template.spec.containers[0];
}

describe("hitless API and web rollouts", () => {
  test("API and web surge before removing a pod and drain before SIGTERM", async () => {
    const manifests = await render({});
    for (const name of ["api", "web"]) {
      const d = deployment(manifests, `hpa-test-opengeni-${name}`);
      expect((d.spec as any).strategy.rollingUpdate).toEqual({ maxSurge: 1, maxUnavailable: 0 });
      expect(container(d).lifecycle).toEqual({ preStop: { sleep: { seconds: 10 } } });
    }
  });

  test("preStopDrainSeconds 0 omits the hook for clusters without the sleep action", async () => {
    const manifests = await render({
      api: { preStopDrainSeconds: 0 },
      web: { preStopDrainSeconds: 0 },
    });
    for (const name of ["api", "web"]) {
      expect(
        container(deployment(manifests, `hpa-test-opengeni-${name}`)).lifecycle,
      ).toBeUndefined();
    }
  });
});
