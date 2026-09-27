import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Kubernetes injects `<SERVICE>_PORT=tcp://<ip>:<port>` style variables into
// every pod for each Service in the namespace unless enableServiceLinks is
// false. OpenGeni reads its settings from OPENGENI_* variables, so a Service
// such as `opengeni-api-metrics` becomes OPENGENI_API_METRICS_PORT=tcp://...
// in every pod that does not set it explicitly, and settings parsing fails at
// startup. OpenGeni pods resolve services through DNS and never read the
// injected variables.

type Manifest = { kind: string; metadata: { name: string }; spec?: any };

async function render(values: Record<string, unknown>): Promise<Manifest[]> {
  const helm = Bun.which("helm");
  if (!helm) throw new Error("helm is required for chart render tests");
  const root = await mkdtemp(join(tmpdir(), "opengeni-service-links-"));
  const valuesPath = join(root, "values.json");
  await Bun.write(valuesPath, JSON.stringify(values));
  try {
    const process = Bun.spawn(
      [helm, "template", "links-test", resolve(import.meta.dir, ".."), "-f", valuesPath],
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

describe("Kubernetes service links", () => {
  test("every OpenGeni pod disables service-link environment variables", async () => {
    const manifests = await render({
      relay: { enabled: true },
      artifactMaterializer: { enabled: true },
      artifactOutboxDispatcher: { enabled: true },
      terraformMcp: { enabled: true },
      observability: { collector: { enabled: true } },
      catalogImport: { enabled: true },
    });
    const pods = manifests.filter(
      (manifest) => manifest.kind === "Deployment" || manifest.kind === "Job",
    );
    const names = pods.map((pod) => pod.metadata.name).sort();
    expect(names).toEqual([
      "links-test-opengeni-api",
      "links-test-opengeni-artifact-materializer",
      "links-test-opengeni-artifact-outbox-dispatcher",
      "links-test-opengeni-catalog-import",
      "links-test-opengeni-migrate",
      "links-test-opengeni-otel-collector",
      "links-test-opengeni-relay",
      "links-test-opengeni-terraform-mcp",
      "links-test-opengeni-web",
      "links-test-opengeni-worker-control",
      "links-test-opengeni-worker-turns",
    ]);
    for (const pod of pods) {
      expect({ name: pod.metadata.name, links: pod.spec.template.spec.enableServiceLinks }).toEqual(
        {
          name: pod.metadata.name,
          links: false,
        },
      );
    }
  });
});
