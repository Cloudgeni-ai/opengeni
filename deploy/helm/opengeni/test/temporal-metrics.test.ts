import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Port = { name: string; containerPort?: number; port?: number; targetPort?: string };
type Manifest = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec?: any;
};

const helm = Bun.which("helm");

async function render(values: Record<string, unknown>): Promise<Manifest[]> {
  if (!helm) throw new Error("helm is required for chart render tests");
  const root = await mkdtemp(join(tmpdir(), "opengeni-temporal-metrics-"));
  const valuesPath = join(root, "values.json");
  await Bun.write(valuesPath, JSON.stringify(values));
  try {
    const child = Bun.spawn(
      [
        helm,
        "template",
        "metrics-test",
        resolve(import.meta.dir, ".."),
        "--api-versions",
        "monitoring.coreos.com/v1",
        "-f",
        valuesPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
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

function find(manifests: Manifest[], kind: string, name: string): Manifest | undefined {
  return manifests.find((manifest) => manifest.kind === kind && manifest.metadata.name === name);
}

function temporalContainer(manifests: Manifest[]) {
  const deployment = find(manifests, "Deployment", "metrics-test-opengeni-temporal");
  expect(deployment).toBeDefined();
  return deployment!.spec.template.spec.containers[0] as {
    ports: Port[];
    env: Array<{ name: string; value?: string }>;
  };
}

const monitoring = {
  namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "observability" } },
  podSelector: { matchLabels: { "app.kubernetes.io/name": "prometheus" } },
};

describe.skipIf(!helm)("bundled Temporal server metrics", () => {
  test("the server exposes its Prometheus endpoint and the scraper finds it", async () => {
    const manifests = await render({
      temporal: { enabled: true },
      observability: { serviceMonitor: { enabled: true, labels: { team: "ops" } } },
      networkPolicy: { enabled: true, monitoring },
    });

    const container = temporalContainer(manifests);
    expect(container.ports).toContainEqual({ name: "metrics", containerPort: 9090 });
    expect(container.env).toContainEqual({ name: "PROMETHEUS_ENDPOINT", value: "0.0.0.0:9090" });

    const service = find(manifests, "Service", "metrics-test-opengeni-temporal");
    expect(service?.metadata.labels?.["opengeni.ai/metrics-endpoint"]).toBe("true");
    expect(service?.spec.ports).toContainEqual({
      name: "metrics",
      port: 9090,
      targetPort: "metrics",
    });

    const monitor = find(manifests, "ServiceMonitor", "metrics-test-opengeni-temporal");
    expect(monitor?.metadata.labels?.team).toBe("ops");
    expect(monitor?.spec.selector.matchLabels).toMatchObject({
      "app.kubernetes.io/component": "temporal",
      "opengeni.ai/metrics-endpoint": "true",
    });
    expect(monitor?.spec.endpoints).toEqual([
      expect.objectContaining({ port: "metrics", path: "/metrics" }),
    ]);

    const policy = find(manifests, "NetworkPolicy", "metrics-test-opengeni-temporal");
    const rules = policy?.spec.ingress as Array<{ from: unknown[]; ports: unknown[] }>;
    // The gRPC port still admits only the API and workers; the metrics port only the scraper.
    expect(rules).toHaveLength(2);
    expect(rules[1]).toEqual({
      from: [
        { namespaceSelector: monitoring.namespaceSelector, podSelector: monitoring.podSelector },
      ],
      ports: [{ protocol: "TCP", port: 9090 }],
    });
  });

  test("no scrape objects without a ServiceMonitor request or a scraper selector", async () => {
    const manifests = await render({
      temporal: { enabled: true },
      networkPolicy: { enabled: true },
    });
    expect(find(manifests, "ServiceMonitor", "metrics-test-opengeni-temporal")).toBeUndefined();
    const policy = find(manifests, "NetworkPolicy", "metrics-test-opengeni-temporal");
    expect(policy?.spec.ingress).toHaveLength(1);
  });

  test("a null port turns the endpoint off entirely", async () => {
    const manifests = await render({
      temporal: { enabled: true, metrics: { port: null } },
      observability: { serviceMonitor: { enabled: true } },
      networkPolicy: { enabled: true, monitoring },
    });
    const container = temporalContainer(manifests);
    expect(container.ports.map((port) => port.name)).toEqual(["grpc"]);
    expect(container.env.map((entry) => entry.name)).not.toContain("PROMETHEUS_ENDPOINT");
    const service = find(manifests, "Service", "metrics-test-opengeni-temporal");
    expect(service?.metadata.labels?.["opengeni.ai/metrics-endpoint"]).toBeUndefined();
    expect(service?.spec.ports.map((port: Port) => port.name)).toEqual(["grpc"]);
    expect(find(manifests, "ServiceMonitor", "metrics-test-opengeni-temporal")).toBeUndefined();
    expect(
      find(manifests, "NetworkPolicy", "metrics-test-opengeni-temporal")?.spec.ingress,
    ).toHaveLength(1);
  });
});
