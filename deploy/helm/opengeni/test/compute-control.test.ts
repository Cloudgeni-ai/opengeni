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

async function helmTemplate(values: Record<string, unknown>) {
  const helm = Bun.which("helm");
  if (!helm) throw new Error("helm is required for chart render tests");
  const root = await mkdtemp(join(tmpdir(), "opengeni-compute-control-"));
  const valuesPath = join(root, "values.json");
  await Bun.write(valuesPath, JSON.stringify(values));
  try {
    const process = Bun.spawn(
      [helm, "template", "cc", resolve(import.meta.dir, ".."), "-f", valuesPath],
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
      "host=cc-opengeni-postgres port=5432 dbname=opengeni user=compute sslmode=disable password=$(COMPUTE_DATABASE_PASSWORD)",
    );
    // The password variable precedes the one that refers to it.
    const names = container.env.map((e: any) => e.name);
    expect(names.indexOf("COMPUTE_DATABASE_PASSWORD")).toBeLessThan(
      names.indexOf("COMPUTE_CONTROL_DATABASE"),
    );
    expect(deployment.spec.template.spec.serviceAccountName).toBe("cc-opengeni-compute-control");
    // Its secrets are mounted 0440, readable through the pod's group.
    expect(deployment.spec.template.spec.securityContext.fsGroup).toBe(
      deployment.spec.template.spec.securityContext.runAsUser,
    );

    find(manifests, "Service", "cc-opengeni-compute-control");
    find(manifests, "Service", "cc-opengeni-compute-control-hosts");
    const job = find(manifests, "Job", "cc-opengeni-compute-control-database");
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
