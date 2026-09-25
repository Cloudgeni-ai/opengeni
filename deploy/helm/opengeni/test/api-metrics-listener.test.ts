import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Manifest = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: any;
  data?: Record<string, string>;
};

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

async function render(values: Record<string, unknown>): Promise<Manifest[]> {
  const helm = Bun.which("helm");
  if (!helm) throw new Error("helm is required for chart render tests");
  const root = await mkdtemp(join(tmpdir(), "opengeni-api-metrics-"));
  const valuesPath = join(root, "values.json");
  await Bun.write(valuesPath, JSON.stringify(values));
  try {
    const process = Bun.spawn(
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

function find(manifests: Manifest[], kind: string, name: string): Manifest | undefined {
  return manifests.find((manifest) => manifest.kind === kind && manifest.metadata.name === name);
}

const scraped = {
  observability: { serviceMonitor: { enabled: true }, collector: { enabled: true } },
  networkPolicy: {
    enabled: true,
    ingressController: {
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" } },
      podSelector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx" } },
    },
    monitoring: {
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "observability" } },
      podSelector: { matchLabels: { "app.kubernetes.io/name": "prometheus" } },
    },
  },
};

describe("API metrics listener chart wiring", () => {
  test("no shipped values route /metrics through an ingress", async () => {
    for (const file of [
      "../values.yaml",
      "../values.aws-managed.example.yaml",
      "../values.azure-existing-services.example.yaml",
      "../values.azure-managed.example.yaml",
      "../values.gcp-managed.example.yaml",
    ]) {
      expect(await source(file)).not.toMatch(/- path: \/metrics\n/u);
    }
  });

  test.skipIf(!Bun.which("helm"))(
    "serves metrics on a dedicated ClusterIP port that only scrapers reach",
    async () => {
      const manifests = await render({
        ...scraped,
        api: { service: { type: "NodePort", port: 8000, nodePort: 30081 } },
      });
      const container = find(manifests, "Deployment", "metrics-test-opengeni-api")!.spec.template
        .spec.containers[0];
      expect(container.ports).toContainEqual({ name: "metrics", containerPort: 9464 });
      expect(container.env).toContainEqual({ name: "OPENGENI_API_METRICS_PORT", value: "9464" });

      const publicService = find(manifests, "Service", "metrics-test-opengeni-api")!;
      expect(publicService.spec.ports.map((port: { name: string }) => port.name)).toEqual(["http"]);
      expect(publicService.metadata.annotations?.["prometheus.io/scrape"]).toBeUndefined();

      const metricsService = find(manifests, "Service", "metrics-test-opengeni-api-metrics")!;
      expect(metricsService.spec.type).toBe("ClusterIP");
      expect(metricsService.spec.ports).toEqual([
        { port: 9464, targetPort: "metrics", protocol: "TCP", name: "metrics" },
      ]);
      expect(metricsService.metadata.annotations?.["prometheus.io/port"]).toBe("9464");

      const monitor = find(manifests, "ServiceMonitor", "metrics-test-opengeni-api")!;
      expect(monitor.spec.selector.matchLabels["opengeni.ai/metrics-endpoint"]).toBe("true");
      expect(monitor.spec.endpoints[0].port).toBe("metrics");

      const collector = find(manifests, "ConfigMap", "metrics-test-opengeni-otel-collector")!;
      expect(collector.data!["collector.yaml"]).toContain("metrics-test-opengeni-api-metrics:9464");

      const policy = find(manifests, "NetworkPolicy", "metrics-test-opengeni-api")!;
      const rules = policy.spec.ingress as Array<{
        from: Array<Record<string, unknown>>;
        ports: Array<{ port: number }>;
      }>;
      const publicRule = rules.find((rule) => rule.ports[0]!.port === 8000)!;
      const metricsRule = rules.find((rule) => rule.ports[0]!.port === 9464)!;
      expect(JSON.stringify(publicRule.from)).not.toContain("otel-collector");
      expect(JSON.stringify(metricsRule.from)).toContain("otel-collector");
      expect(JSON.stringify(metricsRule.from)).toContain("prometheus");
      expect(JSON.stringify(metricsRule.from)).not.toContain("ingress-nginx");
    },
  );

  test.skipIf(!Bun.which("helm"))(
    "keeps the legacy public-port exposition when the dedicated port is disabled",
    async () => {
      const manifests = await render({ ...scraped, api: { metricsPort: null } });
      const container = find(manifests, "Deployment", "metrics-test-opengeni-api")!.spec.template
        .spec.containers[0];
      expect(container.ports).toEqual([{ name: "http", containerPort: 8000 }]);
      expect(find(manifests, "Service", "metrics-test-opengeni-api-metrics")).toBeUndefined();
      const monitor = find(manifests, "ServiceMonitor", "metrics-test-opengeni-api")!;
      expect(monitor.spec.endpoints[0].port).toBe("http");
      expect(monitor.spec.selector.matchLabels["opengeni.ai/metrics-endpoint"]).toBeUndefined();
    },
  );
});

describe("one-shot chart Job cleanup", () => {
  test.skipIf(!Bun.which("helm"))(
    "every chart Job expires one day after it finishes unless disabled",
    async () => {
      const jobs = (manifests: Manifest[]) =>
        manifests.filter((manifest) => manifest.kind === "Job");
      const defaults = jobs(await render({ garage: { enabled: true } }));
      expect(defaults.map((job) => job.metadata.name).sort()).toEqual([
        "metrics-test-opengeni-catalog-import",
        "metrics-test-opengeni-garage-cors",
        "metrics-test-opengeni-migrate",
      ]);
      const minio = jobs(await render({ minio: { enabled: true } }));
      expect(minio.map((job) => job.metadata.name)).toContain("metrics-test-opengeni-minio-bucket");
      for (const job of [...defaults, ...minio]) {
        expect(job.spec.ttlSecondsAfterFinished).toBe(86400);
      }
      for (const job of jobs(await render({ jobTtlSecondsAfterFinished: null }))) {
        expect(job.spec.ttlSecondsAfterFinished).toBeUndefined();
      }
    },
  );
});
