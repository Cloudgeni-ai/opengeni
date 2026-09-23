import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const chart = resolve(import.meta.dir, "..");
const helm = Bun.which("helm");
type Volume = { name: string; [key: string]: unknown };
type Pod = {
  volumes?: Volume[];
  containers: Array<{ name: string; volumeMounts?: Volume[] }>;
};
type Deployment = {
  kind: string;
  metadata: { labels: Record<string, string> };
  spec: { template: { spec: Pod } };
};

async function render(values: Record<string, unknown> = {}): Promise<Map<string, Pod>> {
  if (!helm) throw new Error("helm is required for extra-volume render tests");
  const process = Bun.spawn([helm, "template", "mount-test", chart, "-f", "-"], {
    stdin: new Blob([JSON.stringify(values)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`helm template failed: ${stderr}`);
  return new Map(
    parseAllDocuments(stdout, { version: "1.1" })
      .map((document) => {
        expect(document.errors).toEqual([]);
        return document.toJS() as Deployment;
      })
      .filter((manifest) => manifest.kind === "Deployment")
      .map((manifest) => [
        manifest.metadata.labels["app.kubernetes.io/component"],
        manifest.spec.template.spec,
      ]),
  );
}

function hooks(name: string) {
  return {
    extraVolumes: [
      { name, secret: { secretName: `${name}-secret`, defaultMode: 288 } },
      { name: `${name}-ca`, configMap: { name: `${name}-ca` } },
    ],
    extraVolumeMounts: [
      { name, mountPath: `/etc/telemetry/${name}`, readOnly: true },
      {
        name: `${name}-ca`,
        mountPath: `/etc/telemetry/${name}/ca.crt`,
        subPath: "ca.crt",
        readOnly: true,
      },
    ],
  };
}

describe("additive workload volume hooks", () => {
  test("all six public hooks have empty defaults", async () => {
    const values = Bun.YAML.parse(await readFile(resolve(chart, "values.yaml"), "utf8")) as {
      api: ReturnType<typeof hooks>;
      worker: ReturnType<typeof hooks>;
      observability: { collector: ReturnType<typeof hooks> };
    };
    for (const workload of [values.api, values.worker, values.observability.collector]) {
      expect(workload.extraVolumes).toEqual([]);
      expect(workload.extraVolumeMounts).toEqual([]);
    }
  });

  test.skipIf(!helm)("empty hooks omit unused keys and preserve the collector config", async () => {
    const pods = await render({ observability: { collector: { enabled: true } } });
    for (const component of ["api", "worker-control", "worker-turns"]) {
      const pod = pods.get(component)!;
      expect(pod).toBeDefined();
      expect(pod.volumes).toBeUndefined();
      expect(pod.containers[0]!.volumeMounts).toBeUndefined();
    }
    const collector = pods.get("otel-collector")!;
    expect(collector.volumes).toEqual([
      { name: "config", configMap: { name: "mount-test-opengeni-otel-collector" } },
    ]);
    expect(collector.containers[0]!.volumeMounts).toEqual([
      { name: "config", mountPath: "/conf", readOnly: true },
    ]);
    expect((await render()).has("otel-collector")).toBe(false);
  });

  for (const inventory of [false, true]) {
    test.skipIf(!helm)(
      `renders scoped TLS mounts additively (inventory=${inventory})`,
      async () => {
        const api = hooks("api-tls");
        const worker = hooks("worker-tls");
        const collector = hooks("collector-tls");
        const pods = await render({
          api,
          worker,
          config: { OPENGENI_SANDBOX_BACKEND: inventory ? "opensandbox" : "none" },
          opensandbox: { kubernetesInventory: { enabled: inventory } },
          observability: { collector: { enabled: true, ...collector } },
        });
        for (const [component, expected] of [
          ["api", api],
          ["worker-control", worker],
          ["worker-turns", worker],
          ["otel-collector", collector],
        ] as const) {
          const pod = pods.get(component)!;
          expect(pod).toBeDefined();
          const builtin =
            component === "otel-collector" || (component === "worker-control" && inventory) ? 1 : 0;
          expect(pod.volumes!.slice(builtin)).toEqual(expected.extraVolumes);
          expect(pod.containers[0]!.volumeMounts!.slice(builtin)).toEqual(
            expected.extraVolumeMounts,
          );
        }
        expect(pods.get("otel-collector")!.volumes![0]).toMatchObject({
          name: "config",
          configMap: { name: "mount-test-opengeni-otel-collector" },
        });
        expect(pods.get("otel-collector")!.containers[0]!.volumeMounts![0]).toEqual({
          name: "config",
          mountPath: "/conf",
          readOnly: true,
        });
        if (inventory) {
          expect(pods.get("worker-control")!.volumes![0]).toMatchObject({
            name: "opensandbox-kubernetes-inventory",
            projected: {
              defaultMode: 288,
              sources: [
                { serviceAccountToken: { path: "token", expirationSeconds: 3600 } },
                {
                  configMap: {
                    name: "kube-root-ca.crt",
                    items: [{ key: "ca.crt", path: "ca.crt" }],
                  },
                },
              ],
            },
          });
          expect(pods.get("worker-control")!.containers[0]!.volumeMounts![0]).toEqual({
            name: "opensandbox-kubernetes-inventory",
            mountPath: "/var/run/secrets/opengeni.io/opensandbox-kubernetes-inventory",
            readOnly: true,
          });
        }
        // Hooks are workload-local; unrelated deployments never inherit TLS Secrets.
        for (const [component, pod] of pods) {
          if (["api", "worker-control", "worker-turns", "otel-collector"].includes(component))
            continue;
          expect(JSON.stringify(pod)).not.toContain("-tls");
        }
      },
    );
  }
});
