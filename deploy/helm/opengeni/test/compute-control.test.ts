import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The optional fleet service of Opengeni compute (computeControl): off by
// default, and enabling it adds the service without changing any session's
// sandbox backend.

type Manifest = {
  kind: string;
  metadata: { name: string; annotations?: any };
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
    archive: "gs://example-archive/archive",
    storedImages: { opengeni: "0123abcd" },
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

  test("adds the fleet service, its store and sweep, and points Opengeni at it", async () => {
    const manifests = await render(enabled);
    const deployment = find(manifests, "Deployment", "cc-opengeni-compute-control");
    const container = deployment.spec.template.spec.containers[0];
    expect(container.image).toBe(
      "ghcr.io/cloudgeni-ai/opengeni-compute-control:sha-0123456789abcdef0123456789abcdef01234567",
    );
    expect(container.args).toContain("--archive=gs://example-archive/archive");
    expect(container.args).toContain("--stored-image=opengeni=0123abcd");
    expect(container.args).toContain("--host-ca=/etc/compute/tls/ca.crt");
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
        Object.entries(from.podSelector.matchLabels).every(
          ([key, value]) => labels[key] === value,
        ),
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
        database: { ...enabled.computeControl.database, passwordRevision: "2026-10-18" },
      },
    });
    expect(rotated).not.toBe(installed);
    // A changed pod template cannot be applied to a Job in place.
    const image = await name({ ...enabled, postgres: { enabled: true, image: { tag: "17.9" } } });
    expect(image).not.toBe(installed);
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
          database: { ...enabled.computeControl.database, passwordRevision: "2026-10-18" },
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
});
