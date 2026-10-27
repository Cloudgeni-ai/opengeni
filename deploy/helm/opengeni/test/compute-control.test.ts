import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The optional control service of Opengeni compute (computeControl): off by
// default, and enabling it adds the service without changing any session's
// sandbox backend.

type Manifest = {
  kind: string;
  metadata: { name: string; annotations?: any; labels?: any };
  spec?: any;
  data?: any;
};

async function helmTemplate(values: Record<string, unknown>, flags: string[] = []) {
  const helm = Bun.which("helm");
  if (!helm) throw new Error("helm is required for chart render tests");
  const root = await mkdtemp(join(tmpdir(), "opengeni-compute-control-"));
  const valuesPath = join(root, "values.json");
  await Bun.write(valuesPath, JSON.stringify(values));
  try {
    const process = Bun.spawn(
      [helm, "template", "cc", resolve(import.meta.dir, ".."), "-f", valuesPath, ...flags],
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

async function render(values: Record<string, unknown>, flags: string[] = []): Promise<Manifest[]> {
  const { stdout, stderr, exitCode } = await helmTemplate(values, flags);
  if (exitCode !== 0) throw new Error(`helm template failed: ${stderr}`);
  return stdout
    .split(/^---\s*$/mu)
    .map((document) => document.trim())
    .filter(Boolean)
    .map((document) => Bun.YAML.parse(document) as Manifest)
    .filter((manifest) => manifest && typeof manifest.kind === "string");
}

const enabled = {
  postgres: { enabled: true },
  computeControl: {
    enabled: true,
    image: { tag: "sha-0123456789abcdef0123456789abcdef01234567" },
    database: { existingSecret: "compute-db" },
    keys: { existingSecret: "compute-keys" },
    hostsTls: { secretName: "compute-hosts-tls" },
    hostUrl: "https://compute-control.example.com:8443",
    archive: "gs://example-archive/archive",
    storedImages: { opengeni: "0123abcd" },
    imageSources: {
      opengeni: `registry.example/opengeni-sandbox@sha256:${"a".repeat(64)}`,
    },
  },
};

function find(manifests: Manifest[], kind: string, name: string): Manifest {
  const found = manifests.find((m) => m.kind === kind && m.metadata.name === name);
  if (!found) throw new Error(`no ${kind} ${name}`);
  return found;
}

function databaseJob(manifests: Manifest[]): Manifest {
  const jobs = manifests.filter(
    (m) => m.kind === "Job" && m.metadata.name.startsWith("cc-opengeni-compute-control-database-"),
  );
  expect(jobs).toHaveLength(1);
  return jobs[0]!;
}

describe("computeControl", () => {
  test("is off by default and leaves the configuration alone", async () => {
    const manifests = await render({});
    expect(manifests.filter((m) => m.metadata.name.includes("compute-control"))).toEqual([]);
    const config = find(manifests, "ConfigMap", "cc-opengeni-config");
    expect(config.data.OPENGENI_COMPUTE_API_URL).toBeUndefined();
  });

  test("adds the control service, its store and sweep, and points Opengeni at it", async () => {
    const manifests = await render(enabled);
    const deployment = find(manifests, "Deployment", "cc-opengeni-compute-control");
    const container = deployment.spec.template.spec.containers[0];
    expect(container.image).toBe(
      "ghcr.io/cloudgeni-ai/opengeni-compute-control:sha-0123456789abcdef0123456789abcdef01234567",
    );
    expect(container.args).toContain("--archive=gs://example-archive/archive");
    expect(container.args).toContain("--stored-image=opengeni=0123abcd");
    expect(container.args).toContain(
      `--image-source=opengeni=registry.example/opengeni-sandbox@sha256:${"a".repeat(64)}`,
    );
    // The service is the hosts' authority, and issues its own certificate
    // for the name hosts dial.
    expect(container.args).toContain("--host-authority=/etc/compute/tls");
    expect(container.args).toContain("--host-url=https://compute-control.example.com:8443");
    expect(container.args.some((a: string) => a.startsWith("--gce-"))).toBe(false);
    const database = container.env.find((e: any) => e.name === "COMPUTE_CONTROL_DATABASE");
    expect(database.value).toBe(
      "host='cc-opengeni-postgres' port='5432' dbname='opengeni' user='compute' sslmode='disable'",
    );
    // The password is a variable of its own, never part of the string.
    const password = container.env.find((e: any) => e.name === "COMPUTE_CONTROL_DATABASE_PASSWORD");
    expect(password.valueFrom.secretKeyRef).toEqual({
      name: "compute-db",
      key: "COMPUTE_DATABASE_PASSWORD",
    });
    // Its pods wait for the role and schema the database Job makes.
    const [wait] = deployment.spec.template.spec.initContainers;
    expect(wait.name).toBe("database");
    expect(wait.env.find((e: any) => e.name === "COMPUTE_CONTROL_DATABASE").value).toBe(
      database.value,
    );
    expect(wait.env.find((e: any) => e.name === "PGPASSWORD").valueFrom).toEqual(
      password.valueFrom,
    );
    expect(wait.command[2]).toContain("nspname = 'compute'");
    expect(deployment.spec.template.spec.serviceAccountName).toBe("cc-opengeni-compute-control");
    // Its secrets are mounted 0440, readable through the pod's group.
    expect(deployment.spec.template.spec.securityContext.fsGroup).toBe(
      deployment.spec.template.spec.securityContext.runAsUser,
    );

    find(manifests, "Service", "cc-opengeni-compute-control");
    find(manifests, "Service", "cc-opengeni-compute-control-hosts");
    // The database Job is part of the release, never a hook that Helm's
    // --wait would hold back behind the pods that need it.
    const job = databaseJob(manifests);
    expect(job.metadata.annotations?.["helm.sh/hook"]).toBeUndefined();
    expect(job.metadata.name).toMatch(/^cc-opengeni-compute-control-database-[0-9a-f]{10}$/u);
    const script = job.spec.template.spec.containers[0].command[2];
    expect(script).toContain("set search_path = %I");
    expect(script).toContain("create schema if not exists %I authorization %I");
    const sweep = find(manifests, "CronJob", "cc-opengeni-compute-control-sweep");
    expect(sweep.spec.jobTemplate.spec.template.spec.containers[0].command).toEqual([
      "/usr/local/bin/compute-host",
      "sweep",
      "--store=gs://example-archive/archive",
      "--delete",
    ]);

    const config = find(manifests, "ConfigMap", "cc-opengeni-config");
    expect(config.data.OPENGENI_COMPUTE_API_URL).toBe("http://cc-opengeni-compute-control:8080");
    expect(config.data.OPENGENI_SANDBOX_BACKEND).toBe("modal");
  });

  test("gives the sweep the service's extra credentials too", async () => {
    // Off Google Cloud, a key file mounted from a Secret is the identity of
    // both the service and the sweep that reads and deletes in the archive.
    const key = { name: "gcp-key", secret: { secretName: "compute-gcp-key", defaultMode: 0o440 } };
    const mount = { name: "gcp-key", mountPath: "/etc/compute/gcp", readOnly: true };
    const env = { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/etc/compute/gcp/key.json" };
    const manifests = await render({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        extraEnv: [env],
        extraVolumes: [key],
        extraVolumeMounts: [mount],
      },
    });
    const service = find(manifests, "Deployment", "cc-opengeni-compute-control").spec.template.spec;
    const sweep = find(manifests, "CronJob", "cc-opengeni-compute-control-sweep").spec.jobTemplate
      .spec.template.spec;
    for (const pod of [service, sweep]) {
      expect(pod.containers[0].env).toContainEqual(env);
      expect(pod.containers[0].volumeMounts).toContainEqual(mount);
      expect(pod.volumes).toContainEqual(key);
      // Mounted 0440, readable through the pod's group.
      expect(pod.securityContext.fsGroup).toBe(pod.securityContext.runAsUser);
    }
  });

  test("provisions on the upgrade that first enables it, under network policy", async () => {
    // An existing release with Postgres and network policy turns compute on:
    // the Job is applied with the release's other resources, among them the
    // Postgres policy that admits it, rather than as a hook that would run,
    // and wait for a database it cannot reach, before that policy changes.
    const manifests = await render({ ...enabled, networkPolicy: { enabled: true } }, [
      "--is-upgrade",
    ]);
    const job = databaseJob(manifests);
    expect(job.metadata.annotations?.["helm.sh/hook"]).toBeUndefined();
    const labels = job.spec.template.metadata.labels;
    const policy = find(manifests, "NetworkPolicy", "cc-opengeni-postgres");
    expect(
      policy.spec.ingress[0].from.some((from: any) =>
        Object.entries(from.podSelector.matchLabels).every(([key, value]) => labels[key] === value),
      ),
    ).toBe(true);
  });

  test("makes a new database Job when its inputs change, and keeps it otherwise", async () => {
    const name = async (values: Record<string, unknown>, flags: string[] = []) =>
      databaseJob(await render(values, flags)).metadata.name;
    const installed = await name(enabled);
    // An upgrade with the same inputs leaves the Job that already ran alone.
    expect(await name(enabled, ["--is-upgrade"])).toBe(installed);
    // A new password revision runs it again, before the pods it rolls start.
    const rotated = await name({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        database: { ...enabled.computeControl.database, passwordRevision: 2 },
      },
    });
    expect(rotated).not.toBe(installed);
    // A changed pod template cannot be applied to a Job in place.
    const image = await name({ ...enabled, postgres: { enabled: true, image: { tag: "17.9" } } });
    expect(image).not.toBe(installed);
  });

  test("orders its database Jobs by password revision", async () => {
    const withRevision = (passwordRevision: unknown) => ({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        database: { ...enabled.computeControl.database, passwordRevision },
      },
    });
    const revision = async (passwordRevision: unknown) =>
      databaseJob(
        await render(withRevision(passwordRevision)),
      ).spec.template.spec.containers[0].env.find((e: any) => e.name === "PASSWORD_REVISION").value;
    expect(await revision(0)).toBe("0");
    expect(await revision(20261018)).toBe("20261018");
    expect(await revision("7")).toBe("7");
    // A Job of a lower revision, left running by a failed upgrade, must not
    // give the role its earlier password after a higher one's has run: each
    // records its revision on the role and, under a lock, checks it first.
    const script = databaseJob(await render(enabled)).spec.template.spec.containers[0].command[2];
    expect(script).toContain("pg_advisory_xact_lock");
    expect(script).toContain("as superseded");
    expect(script).toContain("'opengeni compute provisioning, password revision ' || :'revision'");
    // A fraction would round to a revision another value also gives.
    for (const bad of ["2026-10-18", "-1", "next", 1.5, -0.5, -1, 1e20]) {
      const rendered = await helmTemplate(withRevision(bad));
      expect(rendered.exitCode).not.toBe(0);
      expect(rendered.stderr).toContain("passwordRevision must be a whole number");
    }
  });

  test("quotes connection settings and rolls its pods for a new password revision", async () => {
    const settings = (manifests: Manifest[]) => {
      const pod = find(manifests, "Deployment", "cc-opengeni-compute-control").spec.template;
      return {
        database: pod.spec.containers[0].env.find((e: any) => e.name === "COMPUTE_CONTROL_DATABASE")
          .value,
        revision: pod.metadata.annotations["opengeni.ai/compute-control-settings"],
      };
    };
    const before = settings(await render(enabled));
    const after = settings(
      await render({
        ...enabled,
        computeControl: {
          ...enabled.computeControl,
          database: { ...enabled.computeControl.database, passwordRevision: 2 },
        },
      }),
    );
    expect(after.revision).not.toBe(before.revision);
    const external = settings(
      await render({
        ...enabled,
        postgres: { enabled: false },
        computeControl: {
          ...enabled.computeControl,
          database: {
            existingSecret: "compute-db",
            provision: false,
            host: "db.example.com",
            name: "it's",
            sslmode: "verify-full",
          },
        },
      }),
    );
    expect(external.database).toBe(
      "host='db.example.com' port='5432' dbname='it\\'s' user='compute' sslmode='verify-full'",
    );
  });

  test("provisions only the chart's own Postgres", async () => {
    const other = await helmTemplate({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        database: { existingSecret: "compute-db", host: "db.example.com" },
      },
    });
    expect(other.exitCode).not.toBe(0);
    expect(other.stderr).toContain(
      "computeControl.database.provision makes the role and schema in the chart's own Postgres",
    );
    const nowhere = await helmTemplate({
      ...enabled,
      postgres: { enabled: false },
      computeControl: {
        ...enabled.computeControl,
        database: { existingSecret: "compute-db", provision: false },
      },
    });
    expect(nowhere.exitCode).not.toBe(0);
    expect(nowhere.stderr).toContain("computeControl.database.host is required");
    const manifests = await render({
      ...enabled,
      postgres: { enabled: false },
      computeControl: {
        ...enabled.computeControl,
        database: { existingSecret: "compute-db", provision: false, host: "db.example.com" },
      },
    });
    expect(manifests.some((m) => m.metadata.name.includes("compute-control-database"))).toBe(false);
    const pod = find(manifests, "Deployment", "cc-opengeni-compute-control").spec.template.spec;
    expect(pod.initContainers).toBeUndefined();
  });

  test("sweeps only archives it can delete from", async () => {
    const azure = await helmTemplate({
      ...enabled,
      computeControl: { ...enabled.computeControl, archive: "az://account/container" },
    });
    expect(azure.exitCode).not.toBe(0);
    expect(azure.stderr).toContain("computeControl.sweep deletes only from Google Cloud Storage");
    const manifests = await render({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        archive: "s3://bucket/archive",
        sweep: { enabled: false },
      },
    });
    expect(manifests.some((m) => m.kind === "CronJob" && m.metadata.name.includes("sweep"))).toBe(
      false,
    );
  });

  test("lets Postgres take the service's connections under network policy", async () => {
    const manifests = await render({ ...enabled, networkPolicy: { enabled: true } });
    const policy = find(manifests, "NetworkPolicy", "cc-opengeni-postgres");
    const components = policy.spec.ingress[0].from.map(
      (from: any) => from.podSelector.matchLabels["app.kubernetes.io/component"],
    );
    expect(components).toContain("compute-control");
    expect(components).toContain("compute-database");
    find(manifests, "NetworkPolicy", "cc-opengeni-compute-control");
  });

  test("serves the API over HTTPS that Opengeni's callers trust, and signs agent links", async () => {
    const manifests = await render({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        apiTls: { secretName: "compute-api-tls" },
        link: { existingSecret: "compute-link", previousKeys: ["link-2026-09.pem"] },
        teamLinks: { opengeni: "wss://opengeni.example.com/v1/compute/agent-link" },
      },
    });
    const deployment = find(manifests, "Deployment", "cc-opengeni-compute-control");
    const container = deployment.spec.template.spec.containers[0];
    expect(container.args).toContain("--api-tls-cert=/etc/compute/api-tls/tls.crt");
    expect(container.args).toContain("--api-tls-key=/etc/compute/api-tls/tls.key");
    expect(container.args).toContain("--link-key=/etc/compute/link/link.pem");
    expect(container.args).toContain("--link-previous-key=/etc/compute/link/link-2026-09.pem");
    expect(container.args).toContain("--link-issuer=opengeni-compute");
    expect(container.args).toContain(
      "--team-link=opengeni=wss://opengeni.example.com/v1/compute/agent-link",
    );
    const link = deployment.spec.template.spec.volumes.find((v: any) => v.name === "link");
    expect(link.secret.items.map((i: any) => i.key)).toEqual(["link.pem", "link-2026-09.pem"]);

    const config = find(manifests, "ConfigMap", "cc-opengeni-config");
    expect(config.data.OPENGENI_COMPUTE_API_URL).toBe(
      "https://cc-opengeni-compute-control.default.svc:8080",
    );
    expect(config.data.OPENGENI_COMPUTE_LINK_URL).toBe(
      "wss://opengeni.example.com/v1/compute/agent-link",
    );
    for (const name of [
      "cc-opengeni-api",
      "cc-opengeni-worker-control",
      "cc-opengeni-worker-turns",
    ]) {
      const pod = find(manifests, "Deployment", name).spec.template.spec;
      const env = pod.containers[0].env.find((e: any) => e.name === "NODE_EXTRA_CA_CERTS");
      expect(env?.value).toBe("/etc/opengeni/compute-control-ca/ca.crt");
      const volume = pod.volumes.find((v: any) => v.name === "compute-control-ca");
      expect(volume.secret.secretName).toBe("compute-api-tls");
      expect(volume.secret.items).toEqual([{ key: "ca.crt", path: "ca.crt" }]);
      expect(pod.containers[0].volumeMounts).toContainEqual({
        name: "compute-control-ca",
        mountPath: "/etc/opengeni/compute-control-ca",
        readOnly: true,
      });
    }
  });

  test("changes no other workload while it is off", async () => {
    const manifests = await render({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        enabled: false,
        apiTls: { secretName: "compute-api-tls" },
      },
    });
    for (const name of [
      "cc-opengeni-api",
      "cc-opengeni-worker-control",
      "cc-opengeni-worker-turns",
    ]) {
      const pod = find(manifests, "Deployment", name).spec.template.spec;
      expect(JSON.stringify(pod)).not.toContain("compute-control");
    }
  });

  test("refuses team links it cannot sign for", async () => {
    const unsigned = await helmTemplate({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        teamLinks: { opengeni: "wss://opengeni.example.com/link" },
      },
    });
    expect(unsigned.exitCode).not.toBe(0);
    expect(unsigned.stderr).toContain(
      "computeControl.teamLinks needs computeControl.link.existingSecret",
    );
    const plain = await helmTemplate({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        link: { existingSecret: "compute-link" },
        teamLinks: { opengeni: "http://opengeni.example.com/link" },
      },
    });
    expect(plain.exitCode).not.toBe(0);
    expect(plain.stderr).toContain("computeControl.teamLinks.opengeni must be a wss:// URL");
  });

  test("lets GCE instances prove themselves hosts, and refuses a host URL it cannot serve", async () => {
    const manifests = await render({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        hostsTls: { secretName: "compute-hosts-tls", extraNames: ["10.0.0.5"] },
        hostIdentity: {
          gcpProject: "example",
          gcpAccount: "hosts@example.iam.gserviceaccount.com",
        },
      },
    });
    const args = find(manifests, "Deployment", "cc-opengeni-compute-control").spec.template.spec
      .containers[0].args;
    expect(args).toContain("--host-name=10.0.0.5");
    expect(args).toContain("--gce-project=example");
    expect(args).toContain("--gce-host-account=hosts@example.iam.gserviceaccount.com");
    for (const hostUrl of ["", "http://compute-control.example.com:8443", "https://x/path"]) {
      const refused = await helmTemplate({
        ...enabled,
        computeControl: { ...enabled.computeControl, hostUrl },
      });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("computeControl.hostUrl must be the https:// URL");
    }
    const half = await helmTemplate({
      ...enabled,
      computeControl: { ...enabled.computeControl, hostIdentity: { gcpProject: "example" } },
    });
    expect(half.exitCode).not.toBe(0);
    expect(half.stderr).toContain("computeControl.hostIdentity needs both");
  });

  test("refuses to render without an image pin or object storage", async () => {
    const noImage = await helmTemplate({
      ...enabled,
      computeControl: { ...enabled.computeControl, image: { tag: "" } },
    });
    expect(noImage.exitCode).not.toBe(0);
    expect(noImage.stderr).toContain(
      "computeControl.image.tag or computeControl.image.digest is required",
    );
    const localArchive = await helmTemplate({
      ...enabled,
      computeControl: { ...enabled.computeControl, archive: "/var/lib/archive" },
    });
    expect(localArchive.exitCode).not.toBe(0);
    expect(localArchive.stderr).toContain("computeControl.archive must be object storage");
    const unpinned = await helmTemplate({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        imageSources: { opengeni: "registry.example/opengeni-sandbox:v1" },
      },
    });
    expect(unpinned.exitCode).not.toBe(0);
    expect(unpinned.stderr).toContain(
      "computeControl.imageSources.opengeni must be an OCI image pinned by digest",
    );
  });

  test("grows a GCP group only knowing what a new host offers", async () => {
    const group = "projects/p/zones/z/instanceGroupManagers/hosts";
    const unsized = await helmTemplate({
      ...enabled,
      computeControl: { ...enabled.computeControl, gcpGroup: group },
    });
    expect(unsized.exitCode).not.toBe(0);
    expect(unsized.stderr).toContain(
      "computeControl.scaling.hostMemoryMib is required with computeControl.gcpGroup",
    );
    const manifests = await render({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        gcpGroup: group,
        scaling: { hostMemoryMib: 26_438, min: 3, max: 5 },
      },
    });
    const args = find(manifests, "Deployment", "cc-opengeni-compute-control").spec.template.spec
      .containers[0].args;
    expect(args).toContain(`--gcp-group=${group}`);
    expect(args).toContain("--scale-host-memory-mib=26438");
    expect(args).toContain("--scale-min=3");
    expect(args).toContain("--scale-max=5");
    const fixed = (await render(enabled)).find(
      (m) => m.metadata.name === "cc-opengeni-compute-control" && m.kind === "Deployment",
    );
    expect(
      fixed!.spec.template.spec.containers[0].args.some((a: string) => a.startsWith("--scale-")),
    ).toBe(false);
  });

  test("serves its metrics to the scraper only, and passes its hosts' on when asked", async () => {
    const monitoring = {
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "observability" } },
      podSelector: {},
    };
    const store = "http://prometheus.observability:9090/api/v1/otlp/v1/metrics";
    const manifests = await render(
      {
        ...enabled,
        computeControl: { ...enabled.computeControl, metrics: { port: 9464, hostsTo: store } },
        networkPolicy: { enabled: true, monitoring },
        observability: { serviceMonitor: { enabled: true } },
      },
      ["--api-versions", "monitoring.coreos.com/v1"],
    );
    const deployment = find(manifests, "Deployment", "cc-opengeni-compute-control");
    const container = deployment.spec.template.spec.containers[0];
    expect(container.args).toContain("--metrics-listen=0.0.0.0:9464");
    expect(container.args).toContain(`--host-metrics-to=${store}`);
    expect(container.ports).toContainEqual({ name: "metrics", containerPort: 9464 });

    const api = find(manifests, "Service", "cc-opengeni-compute-control");
    expect(api.metadata.labels?.["opengeni.ai/metrics-endpoint"]).toBe("true");
    expect(api.spec.ports).toContainEqual({
      name: "metrics",
      port: 9464,
      targetPort: "metrics",
      protocol: "TCP",
    });
    const hosts = find(manifests, "Service", "cc-opengeni-compute-control-hosts");
    expect(hosts.spec.ports.map((port: any) => port.name)).toEqual(["hosts"]);

    const monitor = find(manifests, "ServiceMonitor", "cc-opengeni-compute-control");
    expect(monitor.spec.selector.matchLabels["opengeni.ai/metrics-endpoint"]).toBe("true");
    expect(monitor.spec.endpoints[0].port).toBe("metrics");

    const policy = find(manifests, "NetworkPolicy", "cc-opengeni-compute-control");
    const scraped = policy.spec.ingress.find((rule: any) =>
      rule.ports.some((port: any) => port.port === 9464),
    );
    expect(scraped.from).toEqual([monitoring]);
  });

  test("has no metrics listener, ServiceMonitor or hosts' metrics unless a port is set", async () => {
    const manifests = await render(
      { ...enabled, observability: { serviceMonitor: { enabled: true } } },
      ["--api-versions", "monitoring.coreos.com/v1"],
    );
    const container = find(manifests, "Deployment", "cc-opengeni-compute-control").spec.template
      .spec.containers[0];
    expect(container.args.some((a: string) => a.startsWith("--metrics-listen"))).toBe(false);
    expect(container.args.some((a: string) => a.startsWith("--host-metrics-to"))).toBe(false);
    expect(
      manifests.some(
        (m) => m.kind === "ServiceMonitor" && m.metadata.name === "cc-opengeni-compute-control",
      ),
    ).toBe(false);
    const withPort = find(
      await render({
        ...enabled,
        computeControl: { ...enabled.computeControl, metrics: { port: 9464 } },
      }),
      "Deployment",
      "cc-opengeni-compute-control",
    ).spec.template.spec.containers[0];
    expect(withPort.args).toContain("--metrics-listen=0.0.0.0:9464");
    expect(withPort.args.some((a: string) => a.startsWith("--host-metrics-to"))).toBe(false);
  });

  test("opens the E2B front door only when asked, with the API's certificate", async () => {
    const off = find(await render(enabled), "Deployment", "cc-opengeni-compute-control").spec
      .template.spec.containers[0];
    expect(off.args.some((a: string) => a.startsWith("--e2b-"))).toBe(false);
    expect(off.ports.map((p: any) => p.name)).not.toContain("e2b");

    const manifests = await render({
      ...enabled,
      networkPolicy: { enabled: true },
      computeControl: {
        ...enabled.computeControl,
        apiTls: { secretName: "compute-api-tls" },
        e2b: {
          enabled: true,
          templates: { base: "base:2x1024", "github-runner": "runner:4x8192x30720" },
          ingressFrom: [{ podSelector: { matchLabels: { app: "e2b-client" } } }],
        },
      },
    });
    const container = find(manifests, "Deployment", "cc-opengeni-compute-control").spec.template
      .spec.containers[0];
    expect(container.args).toContain("--e2b-listen=0.0.0.0:3000");
    expect(container.args).toContain("--e2b-domain=cc-opengeni-compute-control.default.svc");
    expect(container.args).toContain("--e2b-tls-cert=/etc/compute/api-tls/tls.crt");
    expect(container.args).toContain("--e2b-tls-key=/etc/compute/api-tls/tls.key");
    expect(container.args).toContain("--e2b-template=base=base:2x1024");
    expect(container.args).toContain("--e2b-template=github-runner=runner:4x8192x30720");
    expect(container.ports).toContainEqual({ name: "e2b", containerPort: 3000 });
    const service = find(manifests, "Service", "cc-opengeni-compute-control");
    expect(service.spec.ports).toContainEqual({
      name: "e2b",
      port: 3000,
      targetPort: "e2b",
      protocol: "TCP",
    });
    // The hosts' Service never exposes it.
    const hosts = find(manifests, "Service", "cc-opengeni-compute-control-hosts");
    expect(hosts.spec.ports.map((p: any) => p.name)).toEqual(["hosts"]);
    const policy = find(manifests, "NetworkPolicy", "cc-opengeni-compute-control");
    const e2b = policy.spec.ingress.find((rule: any) => rule.ports?.[0]?.port === 3000);
    expect(
      e2b.from.map((from: any) => from.podSelector.matchLabels["app.kubernetes.io/component"]),
    ).toEqual(["compute-runners", undefined]);
    expect(e2b.from[1]).toEqual({ podSelector: { matchLabels: { app: "e2b-client" } } });

    const plain = find(
      await render({
        ...enabled,
        computeControl: { ...enabled.computeControl, e2b: { enabled: true, port: 3100 } },
      }),
      "Deployment",
      "cc-opengeni-compute-control",
    ).spec.template.spec.containers[0];
    expect(plain.args).toContain("--e2b-listen=0.0.0.0:3100");
    expect(plain.args).toContain("--e2b-domain=cc-opengeni-compute-control");
    expect(plain.args.some((a: string) => a.startsWith("--e2b-tls"))).toBe(false);
    expect(plain.args.some((a: string) => a.startsWith("--e2b-template"))).toBe(false);

    const malformed = await helmTemplate({
      ...enabled,
      computeControl: {
        ...enabled.computeControl,
        e2b: { enabled: true, templates: { big: "runner:4x8G" } },
      },
    });
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr).toContain(
      "computeControl.e2b.templates.big must be image:VCPUSxMEMORY_MIB",
    );
  });
});

describe("computeRunners", () => {
  const front = {
    ...enabled,
    computeControl: {
      ...enabled.computeControl,
      apiTls: { secretName: "compute-api-tls" },
      e2b: { enabled: true, templates: { "github-runner": "runner:4x8192x30720" } },
    },
  };
  const pool = {
    name: "ci",
    scope: "example-org/monorepo",
    template: "github-runner",
    github: { existingSecret: "ci-github" },
    compute: { existingSecret: "ci-compute" },
  };

  function container(manifests: Manifest[], name = "cc-opengeni-runners-ci") {
    return find(manifests, "Deployment", name).spec.template.spec.containers[0];
  }

  test("are off by default", async () => {
    const manifests = await render(front);
    expect(manifests.filter((m) => m.metadata.name.includes("runners"))).toEqual([]);
  });

  test("run a pool from the control image against the front door it trusts", async () => {
    const manifests = await render({
      ...front,
      computeRunners: {
        pools: [
          {
            ...pool,
            labels: ["linux", "x64"],
            minIdle: 1,
            max: 6,
            env: { CI_POOL: "ci" },
          },
        ],
      },
    });
    const runner = container(manifests);
    expect(runner.image).toBe(
      "ghcr.io/cloudgeni-ai/opengeni-compute-control:sha-0123456789abcdef0123456789abcdef01234567",
    );
    expect(runner.command).toEqual(["compute-runners"]);
    expect(runner.args).toEqual([
      "serve",
      "--name=ci",
      "--scope=example-org/monorepo",
      "--runner-group=default",
      "--labels=linux,x64",
      "--template=github-runner",
      "--min-idle=1",
      "--max=6",
      "--timeout-s=21600",
      "--env=CI_POOL=ci",
      "--compute-url=https://cc-opengeni-compute-control.default.svc:3000",
      "--compute-ca=/etc/compute-runners/compute-ca/ca.crt",
      "--listen=0.0.0.0:8080",
    ]);
    // Credentials come only from Secrets, never arguments.
    const env = Object.fromEntries(runner.env.map((e: any) => [e.name, e]));
    expect(env.GITHUB_TOKEN.valueFrom.secretKeyRef).toEqual({
      name: "ci-github",
      key: "GITHUB_TOKEN",
    });
    expect(env.COMPUTE_API_KEY.valueFrom.secretKeyRef).toEqual({
      name: "ci-compute",
      key: "COMPUTE_API_KEY",
    });
    expect(env.COMPUTE_RUNNERS_CACHE_TOKEN).toBeUndefined();
    const spec = find(manifests, "Deployment", "cc-opengeni-runners-ci").spec;
    expect(spec.replicas).toBe(1);
    expect(spec.template.spec.serviceAccountName).toBe("cc-opengeni-compute-runners");
    const [ca] = spec.template.spec.volumes;
    expect(spec.template.spec.volumes).toHaveLength(1);
    expect(ca.name).toBe("compute-ca");
    expect(ca.secret.secretName).toBe("compute-api-tls");
    expect(ca.secret.items).toEqual([{ key: "ca.crt", path: "ca.crt" }]);
    expect(runner.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(runner.readinessProbe.httpGet).toEqual({ path: "/healthz", port: "http" });
    // Without a cache, nothing reaches a pool.
    expect(manifests.some((m) => m.kind === "Service" && m.metadata.name.includes("runners"))).toBe(
      false,
    );
    find(manifests, "ServiceAccount", "cc-opengeni-compute-runners");
  });

  test("authenticate as a GitHub App from a mounted key", async () => {
    const runner = container(
      await render({
        ...front,
        computeRunners: {
          pools: [
            {
              ...pool,
              github: {
                existingSecret: "ci-app",
                appId: "Iv1.0123",
                appInstallation: 42,
                appKeyKey: "private-key.pem",
                url: "https://github.example.com",
                apiUrl: "https://github.example.com/api/v3",
              },
            },
          ],
        },
      }),
    );
    expect(runner.args).toContain("--app-id=Iv1.0123");
    expect(runner.args).toContain("--app-installation=42");
    expect(runner.args).toContain("--app-key-file=/etc/compute-runners/github/app.pem");
    expect(runner.args).toContain("--github-url=https://github.example.com");
    expect(runner.args).toContain("--github-api-url=https://github.example.com/api/v3");
    expect(runner.env.some((e: any) => e.name === "GITHUB_TOKEN")).toBe(false);
    expect(runner.volumeMounts).toContainEqual({
      name: "github",
      mountPath: "/etc/compute-runners/github",
      readOnly: true,
    });
  });

  test("keep a warm template and serve a cache that runners reach from outside", async () => {
    const manifests = await render({
      ...front,
      networkPolicy: { enabled: true },
      computeRunners: {
        serviceAccount: { annotations: { "iam.gke.io/gcp-service-account": "cache@example" } },
        pools: [
          {
            ...pool,
            replicaCount: 2,
            warm: {
              repo: "example-org/monorepo",
              prepare: "bun install --frozen-lockfile",
              everySeconds: 1800,
            },
            cache: {
              store: "gs://example-cache/runners",
              url: "https://runner-cache.example.com",
              existingSecret: "ci-cache",
              days: 7,
              service: {
                type: "LoadBalancer",
                port: 443,
                loadBalancerSourceRanges: ["10.0.0.0/8"],
              },
            },
          },
          { ...pool, name: "light", template: "github-runner" },
        ],
      },
    });
    const runner = container(manifests);
    expect(runner.args).toContain("--warm-repo=example-org/monorepo");
    expect(runner.args).toContain("--warm-prepare=bun install --frozen-lockfile");
    expect(runner.args).toContain("--warm-every-s=1800");
    expect(runner.args).toContain("--warm-within-s=3600");
    expect(runner.args.some((a: string) => a.startsWith("--warm-branch"))).toBe(false);
    expect(runner.args).toContain("--cache-store=gs://example-cache/runners");
    expect(runner.args).toContain("--cache-url=https://runner-cache.example.com");
    expect(runner.args).toContain("--cache-days=7");
    const token = runner.env.find((e: any) => e.name === "COMPUTE_RUNNERS_CACHE_TOKEN");
    expect(token.valueFrom.secretKeyRef).toEqual({
      name: "ci-cache",
      key: "COMPUTE_RUNNERS_CACHE_TOKEN",
    });
    expect(find(manifests, "Deployment", "cc-opengeni-runners-ci").spec.replicas).toBe(2);
    expect(
      find(manifests, "ServiceAccount", "cc-opengeni-compute-runners").metadata.annotations,
    ).toEqual({ "iam.gke.io/gcp-service-account": "cache@example" });

    const service = find(manifests, "Service", "cc-opengeni-runners-ci");
    expect(service.spec.type).toBe("LoadBalancer");
    expect(service.spec.loadBalancerSourceRanges).toEqual(["10.0.0.0/8"]);
    expect(service.spec.ports).toEqual([
      { name: "cache", port: 443, targetPort: "http", protocol: "TCP" },
    ]);
    expect(service.spec.selector["opengeni.ai/runner-pool"]).toBe("ci");
    // Only the pool with a cache takes connections, on the cache's port.
    const cachePolicy = find(manifests, "NetworkPolicy", "cc-opengeni-runners-ci");
    expect(cachePolicy.spec.ingress).toEqual([{ ports: [{ protocol: "TCP", port: 8080 }] }]);
    expect(
      manifests.some(
        (m) => m.metadata.name === "cc-opengeni-runners-light" && m.kind !== "Deployment",
      ),
    ).toBe(false);
    const pools = find(manifests, "NetworkPolicy", "cc-opengeni-compute-runners");
    expect(pools.spec.ingress).toEqual([]);
    expect(container(manifests, "cc-opengeni-runners-light").args).not.toContain(
      "--cache-store=gs://example-cache/runners",
    );
  });

  test("serve a cache on a node's own port for a proxy in front of it", async () => {
    const cache = (service: Record<string, unknown>) => ({
      store: "gs://example-cache/runners",
      url: "https://runner-cache.example.com",
      existingSecret: "ci-cache",
      service,
    });
    const ports = async (service: Record<string, unknown>) =>
      find(
        await render({ ...front, computeRunners: { pools: [{ ...pool, cache: cache(service) }] } }),
        "Service",
        "cc-opengeni-runners-ci",
      ).spec;

    const fixed = await ports({ type: "NodePort", nodePort: 30448 });
    expect(fixed.type).toBe("NodePort");
    expect(fixed.ports).toEqual([
      { name: "cache", port: 8080, targetPort: "http", protocol: "TCP", nodePort: 30448 },
    ]);
    // A node port means nothing to any other kind of Service.
    const cluster = await ports({ nodePort: 30448 });
    expect(cluster.type).toBe("ClusterIP");
    expect(cluster.ports[0].nodePort).toBeUndefined();
  });

  test("refuse pools they cannot run", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { ...enabled, computeRunners: { pools: [pool] } },
        "computeRunners.pools need computeControl.enabled and computeControl.e2b.enabled",
      ],
      [
        { ...front, computeRunners: { pools: [{ ...pool, name: "CI" }] } },
        'computeRunners.pools: name "CI" must be 1 to 40 lowercase letters',
      ],
      [
        { ...front, computeRunners: { pools: [pool, pool] } },
        'computeRunners.pools: two pools are named "ci"',
      ],
      [
        { ...front, computeRunners: { pools: [{ ...pool, github: {} }] } },
        "computeRunners.pools.ci.github.existingSecret is required",
      ],
      [
        {
          ...front,
          computeRunners: { pools: [{ ...pool, github: { existingSecret: "a", appId: "1" } }] },
        },
        "computeRunners.pools.ci.github needs both appId and appInstallation",
      ],
      [
        { ...front, computeRunners: { pools: [{ ...pool, compute: {} }] } },
        "computeRunners.pools.ci.compute.existingSecret is required",
      ],
      [
        {
          ...front,
          computeRunners: {
            pools: [
              { ...pool, cache: { store: "/var/cache", url: "https://c", existingSecret: "c" } },
            ],
          },
        },
        "computeRunners.pools.ci.cache.store must be object storage",
      ],
      [
        {
          ...front,
          computeRunners: {
            pools: [{ ...pool, cache: { store: "gs://b/p", existingSecret: "c" } }],
          },
        },
        "computeRunners.pools.ci.cache.url is required",
      ],
    ];
    for (const [values, message] of cases) {
      const result = await helmTemplate(values);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
    }
  });
});
