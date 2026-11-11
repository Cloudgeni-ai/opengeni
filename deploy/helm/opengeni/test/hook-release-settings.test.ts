import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { getSettings } from "@opengeni/config";
import { parseAllDocuments } from "yaml";

type Resource = {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  spec?: { template: { spec: { containers: Container[] } } };
};
type Container = {
  envFrom?: Array<{ configMapRef?: { name: string }; secretRef?: { name: string } }>;
  env?: Array<{
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef: { name: string; key: string } };
  }>;
};
const chart = resolve(import.meta.dir, "..");
const helm = Bun.which("helm");
const key = (resource: Resource) => `${resource.kind}/${resource.metadata.name}`;
const events = (resource: Resource) =>
  resource.metadata.annotations?.["helm.sh/hook"]?.split(",").map((event) => event.trim()) ?? [];
const weight = (resource: Resource) =>
  Number(resource.metadata.annotations?.["helm.sh/hook-weight"] ?? 0);
const managed = {
  OPENGENI_ENVIRONMENT: "production",
  OPENGENI_PRODUCT_ACCESS_MODE: "managed",
  OPENGENI_SANDBOX_BACKEND: "none",
  OPENGENI_PUBLIC_BASE_URL: "https://managed.example.test",
  OPENGENI_BETTER_AUTH_SECRET: "fixture-auth-secret",
  OPENGENI_DELEGATION_SECRET: "fixture-delegation-secret",
  OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

async function render(values: Record<string, unknown> = {}, upgrade = false) {
  if (!helm) throw new Error("helm is required for hook settings regression tests");
  const process = Bun.spawn(
    [helm, "template", "settings-test", chart, ...(upgrade ? ["--is-upgrade"] : []), "-f", "-"],
    { stdin: new Blob([JSON.stringify(values)]), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return parseAllDocuments(stdout).map((document) => {
    expect(document.errors).toEqual([]);
    return document.toJS() as Resource;
  });
}

function environment(container: Container, live: Map<string, Resource>) {
  const env: Record<string, string> = {};
  const data = (kind: string, name: string) => {
    const resource = live.get(`${kind}/${name}`);
    if (!resource) throw new Error(`Missing ${kind}/${name} before hook execution`);
    return resource.stringData ?? resource.data ?? {};
  };
  for (const source of container.envFrom ?? []) {
    if (source.configMapRef) Object.assign(env, data("ConfigMap", source.configMapRef.name));
    if (source.secretRef) Object.assign(env, data("Secret", source.secretRef.name));
  }
  for (const variable of container.env ?? []) {
    const ref = variable.valueFrom?.secretKeyRef;
    if (ref) env[variable.name] = data("Secret", ref.name)[ref.key]!;
    else if (variable.value !== undefined) env[variable.name] = variable.value;
  }
  return env;
}

// Real Helm renders; model only the documented lifecycle: pre-upgrade hooks
// run by weight before normal resources are updated. Secret data is synthetic.
function runHooks(resources: Resource[], event: string, live: Map<string, Resource>) {
  const jobs = new Map<string, Record<string, string>>();
  for (const resource of resources
    .filter((item) => events(item).includes(event))
    .sort((a, b) => weight(a) - weight(b))) {
    if (resource.kind === "Job") {
      jobs.set(
        resource.metadata.name,
        environment(resource.spec!.template.spec.containers[0]!, live),
      );
    } else live.set(key(resource), resource);
  }
  return jobs;
}

for (const create of [false, true]) {
  for (const delivery of ["disabled", "resend"] as const) {
    test(`pre-upgrade uses incoming config and ${create ? "chart-managed" : "external"} Secret when switching to ${delivery}`, async () => {
      const config = (mode: string) => ({ ...managed, OPENGENI_MANAGED_EMAIL_DELIVERY: mode });
      const credentials = (mode: string) => ({
        ...(mode === "resend" ? { OPENGENI_RESEND_API_KEY: "fixture-provider-key" } : {}),
        OPENGENI_MODEL: "secret-model-override",
      });
      const oldMode = delivery === "disabled" ? "resend" : "disabled";
      const previous = await render({
        config: { ...config(oldMode), RETIRED_SETTING: "old-value" },
        secret: { create, stringData: credentials(oldMode) },
      });
      const incoming = await render(
        {
          config: { ...config(delivery), OPENGENI_MODEL: "config-default" },
          secret: { create, stringData: credentials(delivery) },
        },
        true,
      );
      const live = new Map(
        previous.filter((item) => events(item).length === 0).map((item) => [key(item), item]),
      );
      if (!create)
        live.set("Secret/opengeni-runtime", {
          kind: "Secret",
          metadata: { name: "opengeni-runtime" },
          stringData: credentials(delivery),
        });
      if (!create) {
        const previousJob = previous.find(
          (item) => item.kind === "Job" && item.metadata.name.endsWith("-migrate"),
        )!;
        const oldContainer = structuredClone(previousJob.spec!.template.spec.containers[0]!);
        // The pre-fix hook read this ordinary ConfigMap, which is still old.
        oldContainer.envFrom![0] = { configMapRef: { name: "settings-test-opengeni-config" } };
        expect(() => getSettings(environment(oldContainer, live))).toThrow(
          delivery === "disabled"
            ? "OPENGENI_RESEND_API_KEY is required"
            : "OPENGENI_RESEND_API_KEY must be unset",
        );
      }
      const settings = runHooks(incoming, "pre-upgrade", live).get(
        "settings-test-opengeni-migrate",
      )!;
      expect(settings.OPENGENI_MANAGED_EMAIL_DELIVERY).toBe(delivery);
      expect(settings.OPENGENI_MODEL).toBe("secret-model-override");
      expect(settings.RETIRED_SETTING).toBeUndefined();
      expect(getSettings(settings).managedEmailDelivery).toBe(delivery);
      expect(
        live.get("ConfigMap/settings-test-opengeni-config")!.data!.OPENGENI_MANAGED_EMAIL_DELIVERY,
      ).toBe(oldMode);
    });
  }
}

test("both Jobs use identical generated config, earlier snapshots, and separate owner credentials", async () => {
  const resources = await render(
    {
      secret: { create: true, stringData: { OPENGENI_DATABASE_URL: "runtime-url" } },
      migrations: {
        secret: { existingSecret: "migration-owner" },
        annotations: { "helm.sh/hook-weight": "-20" },
      },
      catalogImport: {
        annotations: { "helm.sh/hook": "pre-upgrade", "helm.sh/hook-weight": "-30" },
      },
      sessionArchive: { enabled: false },
      selfhosted: { enabled: true, relayUrl: "wss://relay.example.test" },
      artifactMaterializer: { enabled: true },
    },
    true,
  );
  const runtimeConfig = resources.find(
    (item) => item.kind === "ConfigMap" && item.metadata.name === "settings-test-opengeni-config",
  )!;
  for (const job of resources.filter(
    (item) =>
      item.kind === "Job" &&
      ["settings-test-opengeni-migrate", "settings-test-opengeni-catalog-import"].includes(
        item.metadata.name,
      ),
  )) {
    const container = job.spec!.template.spec.containers[0]!;
    const configName = container.envFrom![0]!.configMapRef!.name;
    expect(configName).not.toBe(runtimeConfig.metadata.name);
    const snapshot = resources.find(
      (item) => item.kind === "ConfigMap" && item.metadata.name === configName,
    )!;
    expect(snapshot.data).toEqual(runtimeConfig.data);
    expect(events(snapshot)).toEqual(events(job));
    expect(weight(snapshot)).toBeLessThan(weight(job));
    expect(snapshot.metadata.annotations?.["helm.sh/hook-delete-policy"]).toBe(
      "before-hook-creation,hook-succeeded",
    );
  }
  const live = new Map<string, Resource>([
    [
      "Secret/migration-owner",
      {
        kind: "Secret",
        metadata: { name: "migration-owner" },
        stringData: {
          OPENGENI_MIGRATIONS_DATABASE_URL: "owner-url",
          OPENGENI_MODEL: "owner-override",
        },
      },
    ],
  ]);
  const jobs = runHooks(resources, "pre-upgrade", live);
  expect(jobs.get("settings-test-opengeni-migrate")!.OPENGENI_DATABASE_URL).toBe("runtime-url");
  expect(jobs.get("settings-test-opengeni-migrate")!.OPENGENI_MODEL).toBe("owner-override");
  expect(jobs.get("settings-test-opengeni-catalog-import")!.OPENGENI_DATABASE_URL).toBe(
    "owner-url",
  );
});

test("post-install snapshots exist before Jobs and disabled Jobs emit no snapshots", async () => {
  const resources = await render({ secret: { create: true } });
  const live = new Map(
    resources.filter((item) => events(item).length === 0).map((item) => [key(item), item]),
  );
  expect(runHooks(resources, "post-install", live).size).toBe(2);
  const disabled = await render({
    migrations: { enabled: false },
    catalogImport: { enabled: false },
  });
  expect(
    disabled.filter(
      (item) =>
        item.metadata.name.endsWith("-migrate-config") ||
        item.metadata.name.endsWith("-catalog-import-config"),
    ),
  ).toEqual([]);
});

test("catalog fallback uses its incoming runtime Secret and non-hook Jobs keep ordinary settings resources", async () => {
  const resources = await render({
    secret: { create: true, stringData: { OPENGENI_MIGRATIONS_DATABASE_URL: "fixture-owner-url" } },
    migrations: { annotations: null },
    catalogImport: { annotations: null },
  });
  const live = new Map(resources.map((item) => [key(item), item]));
  for (const component of ["migrate", "catalog-import"]) {
    const job = live.get(`Job/settings-test-opengeni-${component}`)!;
    expect(events(job)).toEqual([]);
    const snapshot = live.get(`ConfigMap/settings-test-opengeni-${component}-config`)!;
    expect(events(snapshot)).toEqual([]);
    const env = environment(job.spec!.template.spec.containers[0]!, live);
    expect(env.OPENGENI_MIGRATIONS_DATABASE_URL).toBe("fixture-owner-url");
    if (component === "catalog-import") expect(env.OPENGENI_DATABASE_URL).toBe("fixture-owner-url");
  }
  const noApi = await render({ api: { enabled: false }, secret: { create: true } });
  expect(
    noApi.some((item) => /-(migrate|catalog-import)-(config|runtime)$/.test(item.metadata.name)),
  ).toBe(false);
});
