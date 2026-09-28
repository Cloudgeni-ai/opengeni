import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const chart = resolve(import.meta.dir, "..");
const helm = Bun.which("helm");
type Env = { name: string; value?: string; valueFrom?: unknown };
type Resource = {
  kind: string;
  metadata: { labels?: Record<string, string> };
  data?: Record<string, string>;
  spec?: { template?: { spec: { containers: Array<{ env?: Env[] }> } } };
};

async function render(values: Record<string, unknown> = {}) {
  if (!helm) throw new Error("helm is required for workload environment tests");
  const child = Bun.spawn([helm, "template", "env-test", chart, "-f", "-"], {
    stdin: new Blob([JSON.stringify(values)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(err);
  return parseAllDocuments(out).map((document) => {
    expect(document.errors).toEqual([]);
    return document.toJS() as Resource;
  });
}

describe("workload-local environment configuration", () => {
  test("both optional lists have empty defaults", async () => {
    const values = Bun.YAML.parse(await readFile(resolve(chart, "values.yaml"), "utf8")) as {
      api: { extraEnv: Env[] };
      worker: { extraEnv: Env[] };
    };
    expect(values.api.extraEnv).toEqual([]);
    expect(values.worker.extraEnv).toEqual([]);
  });

  test.skipIf(!helm)(
    "settings reach only the selected API and worker containers, never shared config or hooks",
    async () => {
      const api: Env[] = [{ name: "NODE_EXTRA_CA_CERTS", value: "/etc/api-ca/ca.crt" }];
      const worker: Env[] = [
        { name: "NODE_EXTRA_CA_CERTS", value: "/etc/worker-ca/ca.crt" },
        {
          name: "CUSTOM_SETTING",
          valueFrom: { secretKeyRef: { name: "custom-setting", key: "value" } },
        },
      ];
      const resources = await render({ api: { extraEnv: api }, worker: { extraEnv: worker } });
      const seen: string[] = [];
      for (const resource of resources) {
        const component = resource.metadata.labels?.["app.kubernetes.io/component"] ?? "";
        const expected =
          component === "api"
            ? api
            : ["worker-control", "worker-turns"].includes(component)
              ? worker
              : [];
        if (expected.length && resource.kind === "Deployment") seen.push(component);
        if (resource.kind === "ConfigMap")
          expect(JSON.stringify(resource.data)).not.toContain("NODE_EXTRA_CA_CERTS");
        for (const container of resource.spec?.template?.spec.containers ?? []) {
          expect(
            (container.env ?? []).filter((entry) =>
              ["NODE_EXTRA_CA_CERTS", "CUSTOM_SETTING"].includes(entry.name),
            ),
          ).toEqual(expected);
          if (component.startsWith("worker-")) {
            expect(
              container.env?.find((entry) => entry.name === "OPENGENI_WORKER_ROLE")?.value,
            ).toBe(component === "worker-control" ? "control" : "turn");
          }
        }
      }
      expect(seen.toSorted()).toEqual(["api", "worker-control", "worker-turns"]);
      expect(resources.filter((resource) => resource.kind === "Job").length).toBeGreaterThanOrEqual(
        2,
      );
    },
  );

  test.skipIf(!helm)(
    "API settings also render when no built-in environment entries are selected",
    async () => {
      const values = {
        api: { metricsPort: null, extraEnv: [{ name: "CUSTOM_SETTING", value: "selected" }] },
        config: { OPENGENI_DEPLOYMENT_REVISION: "" },
        postgres: { enabled: false },
        temporal: { enabled: false },
        garage: { enabled: false },
        minio: { enabled: false },
      };
      const api = (await render(values)).find(
        (resource) =>
          resource.kind === "Deployment" &&
          resource.metadata.labels?.["app.kubernetes.io/component"] === "api",
      );
      expect(api?.spec?.template?.spec.containers[0]?.env).toEqual([
        { name: "CUSTOM_SETTING", value: "selected" },
      ]);
    },
  );

  for (const role of ["api", "worker"]) {
    for (const invalid of [
      { name: "CUSTOM_SETTING", value: "not-a-list" },
      [
        { name: "CUSTOM_SETTING", value: "a" },
        { name: "CUSTOM_SETTING", value: "b" },
      ],
      [{ name: "CUSTOM_SETTING" }],
      [
        {
          name: "CUSTOM_SETTING",
          value: "a",
          valueFrom: { secretKeyRef: { name: "x", key: "x" } },
        },
      ],
      [{ name: "CUSTOM_SETTING", value: 123 }],
      [{ name: "OPENGENI_DEPLOYMENT_REVISION", value: "wrong-source" }],
      [{ name: "OPENGENI_DATABASE_URL", value: "wrong-generated-service" }],
    ]) {
      test.skipIf(!helm)(
        `${role} refuses malformed, duplicate or chart-owned settings: ${JSON.stringify(invalid)}`,
        async () => {
          await expect(
            render({ [role]: { extraEnv: invalid }, postgres: { enabled: true } }),
          ).rejects.toThrow();
        },
      );
    }
  }
  test.skipIf(!helm)(
    "worker roles and listeners cannot be overridden through extra settings",
    async () => {
      for (const name of [
        "OPENGENI_WORKER_ROLE",
        "OPENGENI_WORKER_HTTP_PORT",
        "OPENGENI_OPENSANDBOX_KUBERNETES_INVENTORY_NAMESPACE",
      ])
        await expect(
          render({ worker: { extraEnv: [{ name, value: "wrong" }] } }),
        ).rejects.toThrow();
      await expect(
        render({ api: { extraEnv: [{ name: "OPENGENI_API_METRICS_PORT", value: "wrong" }] } }),
      ).rejects.toThrow();
    },
  );
});
