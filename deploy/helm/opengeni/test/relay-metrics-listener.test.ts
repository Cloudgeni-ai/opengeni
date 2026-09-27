import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Manifest = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: any;
};

type IngressValues = {
  ingress?: { hosts?: Array<{ host: string; paths?: Array<{ path: string; service: string }> }> };
};

async function helmTemplate(values: Record<string, unknown>) {
  const helm = Bun.which("helm");
  if (!helm) throw new Error("helm is required for chart render tests");
  const root = await mkdtemp(join(tmpdir(), "opengeni-relay-metrics-"));
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
    return { stdout, stderr, exitCode };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function render(values: Record<string, unknown>): Promise<Manifest[]> {
  const { stdout, stderr, exitCode } = await helmTemplate(values);
  if (exitCode !== 0) throw new Error(`helm template failed: ${stderr}`);
  return stdout
    .split(/^---\s*$/mu)
    .map((document) => document.trim())
    .filter(Boolean)
    .map((document) => Bun.YAML.parse(document) as Manifest)
    .filter((manifest) => manifest && typeof manifest.kind === "string");
}

function find(manifests: Manifest[], kind: string, name: string): Manifest | undefined {
  return manifests.find((manifest) => manifest.kind === kind && manifest.metadata.name === name);
}

type PolicyRule = { from: Array<Record<string, unknown>>; ports: Array<{ port: number }> };

const scrapedRelay = {
  relay: { enabled: true, service: { type: "NodePort", port: 8443, nodePort: 30443 } },
  observability: { serviceMonitor: { enabled: true } },
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

describe("relay metrics listener chart wiring", () => {
  test("shipped values route only the relay stream and probe paths through an ingress", async () => {
    for (const file of [
      "../values.yaml",
      "../values.aws-managed.example.yaml",
      "../values.azure-existing-services.example.yaml",
      "../values.azure-managed.example.yaml",
      "../values.gcp-managed.example.yaml",
      "../values.local-kubernetes.example.yaml",
      "../values.preview-managed.example.yaml",
      "../values.single-node.example.yaml",
    ]) {
      const values = Bun.YAML.parse(
        await readFile(new URL(file, import.meta.url), "utf8"),
      ) as IngressValues;
      for (const host of values.ingress?.hosts ?? []) {
        for (const route of host.paths ?? []) {
          if (route.service !== "relay") continue;
          expect(["/stream", "/healthz"]).toContain(route.path);
        }
      }
    }
  });

  test.skipIf(!Bun.which("helm"))(
    "serves relay metrics on a dedicated ClusterIP port that only the scraper reaches",
    async () => {
      const manifests = await render(scrapedRelay);
      const container = find(manifests, "Deployment", "metrics-test-opengeni-relay")!.spec.template
        .spec.containers[0];
      expect(container.ports).toEqual([
        { name: "wss", containerPort: 8443 },
        { name: "metrics", containerPort: 9464 },
      ]);
      expect(container.env).toContainEqual({
        name: "OPENGENI_RELAY_METRICS_BIND",
        value: "0.0.0.0:9464",
      });

      const publicService = find(manifests, "Service", "metrics-test-opengeni-relay")!;
      expect(publicService.spec.type).toBe("NodePort");
      expect(publicService.spec.ports.map((port: { name: string }) => port.name)).toEqual(["wss"]);
      expect(publicService.metadata.annotations?.["prometheus.io/scrape"]).toBeUndefined();

      const metricsService = find(manifests, "Service", "metrics-test-opengeni-relay-metrics")!;
      expect(metricsService.spec.type).toBe("ClusterIP");
      expect(metricsService.spec.ports).toEqual([
        { port: 9464, targetPort: "metrics", protocol: "TCP", name: "metrics" },
      ]);
      expect(metricsService.spec.selector["app.kubernetes.io/component"]).toBe("relay");
      expect(metricsService.metadata.annotations?.["prometheus.io/port"]).toBe("9464");

      const monitor = find(manifests, "ServiceMonitor", "metrics-test-opengeni-relay")!;
      expect(monitor.spec.selector.matchLabels).toMatchObject({
        "app.kubernetes.io/component": "relay",
        "opengeni.ai/metrics-endpoint": "true",
      });
      expect(monitor.spec.endpoints[0].port).toBe("metrics");
      // Series keep the public relay Service identity for existing dashboards.
      expect(monitor.spec.endpoints[0].relabelings).toEqual(
        expect.arrayContaining([
          { targetLabel: "service", replacement: "metrics-test-opengeni-relay" },
          { targetLabel: "job", replacement: "metrics-test-opengeni-relay" },
        ]),
      );
      // The API ServiceMonitor must not pick up the relay metrics Service.
      const apiMonitor = find(manifests, "ServiceMonitor", "metrics-test-opengeni-api")!;
      expect(apiMonitor.spec.selector.matchLabels["app.kubernetes.io/component"]).toBe("api");

      const policy = find(manifests, "NetworkPolicy", "metrics-test-opengeni-relay")!;
      const rules = policy.spec.ingress as PolicyRule[];
      expect(rules.map((rule) => rule.ports[0]!.port).sort()).toEqual([8443, 9464]);
      const wssRule = rules.find((rule) => rule.ports[0]!.port === 8443)!;
      const metricsRule = rules.find((rule) => rule.ports[0]!.port === 9464)!;
      expect(JSON.stringify(wssRule.from)).toContain("ingress-nginx");
      expect(JSON.stringify(wssRule.from)).not.toContain("prometheus");
      expect(JSON.stringify(metricsRule.from)).toContain("prometheus");
      expect(JSON.stringify(metricsRule.from)).not.toContain("ingress-nginx");
    },
  );

  test.skipIf(!Bun.which("helm"))(
    "admits nobody to the relay metrics port when no scraper is configured",
    async () => {
      const manifests = await render({
        ...scrapedRelay,
        networkPolicy: { ...scrapedRelay.networkPolicy, monitoring: {} },
      });
      const policy = find(manifests, "NetworkPolicy", "metrics-test-opengeni-relay")!;
      const rules = policy.spec.ingress as PolicyRule[];
      expect(rules.map((rule) => rule.ports[0]!.port)).toEqual([8443]);
      expect(JSON.stringify(rules[0]!.from)).not.toContain("prometheus");
    },
  );

  test.skipIf(!Bun.which("helm"))(
    "keeps the legacy wss-port exposition when the dedicated port is disabled",
    async () => {
      const manifests = await render({
        ...scrapedRelay,
        relay: { ...scrapedRelay.relay, metricsPort: null },
      });
      const container = find(manifests, "Deployment", "metrics-test-opengeni-relay")!.spec.template
        .spec.containers[0];
      expect(container.ports).toEqual([{ name: "wss", containerPort: 8443 }]);
      expect(
        container.env.some(
          (entry: { name: string }) => entry.name === "OPENGENI_RELAY_METRICS_BIND",
        ),
      ).toBe(false);
      expect(find(manifests, "Service", "metrics-test-opengeni-relay-metrics")).toBeUndefined();
      const publicService = find(manifests, "Service", "metrics-test-opengeni-relay")!;
      expect(publicService.metadata.annotations?.["prometheus.io/port"]).toBe("8443");
      const monitor = find(manifests, "ServiceMonitor", "metrics-test-opengeni-relay")!;
      expect(monitor.spec.endpoints[0].port).toBe("wss");
      expect(monitor.spec.selector.matchLabels["opengeni.ai/metrics-endpoint"]).toBeUndefined();
      const policy = find(manifests, "NetworkPolicy", "metrics-test-opengeni-relay")!;
      const rules = policy.spec.ingress as PolicyRule[];
      expect(rules).toHaveLength(1);
      expect(JSON.stringify(rules[0]!.from)).toContain("prometheus");
    },
  );

  test.skipIf(!Bun.which("helm"))("refuses a metrics port that shares the wss port", async () => {
    const { exitCode, stderr } = await helmTemplate({
      relay: { enabled: true, metricsPort: 8443 },
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("relay.metricsPort must differ from relay.containerPort");
  });
});
