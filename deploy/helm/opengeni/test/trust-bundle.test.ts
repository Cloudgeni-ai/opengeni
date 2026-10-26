import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const chart = resolve(import.meta.dir, "..");
const compute = {
  enabled: true,
  image: { tag: "sha-0123456789abcdef0123456789abcdef01234567" },
  database: { existingSecret: "compute-db" },
  keys: { existingSecret: "compute-keys" },
  hostsTls: { secretName: "compute-hosts-tls" },
  hostUrl: "https://compute.example.test:8443",
  archive: "gs://example-archive/archive",
  storedImages: { opengeni: "0123abcd" },
  apiTls: {
    secretName: "compute-tls",
    additionalCaConfigMaps: [{ name: "telemetry-ca", key: "ca.crt" }],
  },
};
function render(values: Record<string, unknown>) {
  const result = spawnSync("helm", ["template", "trust", chart, "-f", "-"], {
    input: JSON.stringify({ postgres: { enabled: true }, ...values }),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout
    .split(/^---\s*$/m)
    .map((text) => Bun.YAML.parse(text) as any)
    .filter(Boolean);
}
function workloads(values: Record<string, unknown>) {
  return render(values).filter(
    (doc) =>
      doc.kind === "Deployment" &&
      ["api", "worker-control", "worker-turns"].includes(
        doc.metadata.labels?.["app.kubernetes.io/component"],
      ),
  );
}

test("optional trust composition reuses each exact workload image and keeps role-local trust", () => {
  const docs = workloads({
    computeControl: compute,
    api: { image: { digest: "sha256:api" } },
    worker: { image: { digest: "sha256:worker" } },
  });
  expect(docs).toHaveLength(3);
  for (const doc of docs) {
    const pod = doc.spec.template.spec;
    const app = pod.containers[0];
    const init = pod.initContainers[0];
    expect(pod.initContainers).toHaveLength(1);
    expect(pod.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    });
    expect(init.image).toBe(app.image);
    expect(init.image).toContain("@sha256:");
    expect(init.env).toBeUndefined();
    expect(init.envFrom).toBeUndefined();
    expect(init.securityContext).toEqual({
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(init.resources.limits).toEqual({ cpu: "100m", memory: "128Mi" });
    expect(init.args).toEqual([
      "/etc/opengeni/runtime-ca/ca.crt",
      "/etc/opengeni/compute-control-ca/ca.crt",
      "/etc/opengeni/additional-ca/0.crt",
    ]);
    expect(app.env.filter((entry: any) => entry.name === "NODE_EXTRA_CA_CERTS")).toEqual([
      { name: "NODE_EXTRA_CA_CERTS", value: "/etc/opengeni/runtime-ca/ca.crt" },
    ]);
    expect(app.volumeMounts.find((mount: any) => mount.name === "runtime-ca").readOnly).toBe(true);
    expect(
      app.volumeMounts.find((mount: any) => mount.name === "compute-control-ca").readOnly,
    ).toBe(true);
    expect(pod.volumes.find((v: any) => v.name === "additional-ca").projected.sources).toEqual([
      {
        configMap: {
          name: "telemetry-ca",
          optional: false,
          items: [{ key: "ca.crt", path: "0.crt" }],
        },
      },
    ]);
    if (doc.metadata.labels["app.kubernetes.io/component"].startsWith("worker-")) {
      expect(app.env.find((entry: any) => entry.name === "OPENGENI_WORKER_ROLE").value).toBe(
        doc.metadata.labels["app.kubernetes.io/component"] === "worker-control"
          ? "control"
          : "turn",
      );
    }
  }
  for (const doc of render({ computeControl: compute }).filter(
    (resource) =>
      !["api", "worker-control", "worker-turns"].includes(
        resource.metadata.labels?.["app.kubernetes.io/component"],
      ),
  )) {
    expect(JSON.stringify(doc)).not.toContain("compose-runtime-ca");
  }
});

test("default compute trust and compute-disabled deployments have no initializer", () => {
  for (const doc of workloads({
    computeControl: { ...compute, apiTls: { secretName: "compute-tls" } },
  })) {
    expect(doc.spec.template.spec.initContainers).toBeUndefined();
    expect(
      doc.spec.template.spec.containers[0].env.find(
        (entry: any) => entry.name === "NODE_EXTRA_CA_CERTS",
      ).value,
    ).toBe("/etc/opengeni/compute-control-ca/ca.crt");
  }
  for (const doc of workloads({ computeControl: { ...compute, enabled: false } })) {
    expect(doc.spec.template.spec.initContainers).toBeUndefined();
    expect(
      doc.spec.template.spec.containers[0].env.some(
        (entry: any) => entry.name === "NODE_EXTRA_CA_CERTS",
      ),
    ).toBe(false);
  }
});

test("compute trust cannot be silently shadowed by workload environment", () => {
  for (const role of ["api", "worker"]) {
    expect(() =>
      render({
        computeControl: compute,
        [role]: { extraEnv: [{ name: "NODE_EXTRA_CA_CERTS", value: "/other/ca.crt" }] },
      }),
    ).toThrow("chart-owned");
  }
  for (const source of [
    { name: "telemetry-ca" },
    { name: "../bad", key: "ca.crt" },
    { name: "telemetry-ca", key: "../ca.crt" },
  ]) {
    expect(() =>
      render({
        computeControl: {
          ...compute,
          apiTls: { ...compute.apiTls, additionalCaConfigMaps: [source] },
        },
      }),
    ).toThrow("additionalCaConfigMaps");
  }
});

let directory: string;
function openssl(args: string[]) {
  const result = spawnSync("openssl", args, { cwd: directory, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "opengeni-trust-bundle-"));
  for (const name of ["compute", "telemetry", "untrusted"]) {
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}-ca.key`,
      "-out",
      `${name}-ca.crt`,
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      "/CN=localhost",
    ]);
    writeFileSync(
      join(directory, "server.ext"),
      "basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n",
    );
    openssl([
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      `${name}-ca.crt`,
      "-CAkey",
      `${name}-ca.key`,
      "-CAcreateserial",
      "-out",
      `${name}.crt`,
      "-days",
      "1",
      "-extfile",
      "server.ext",
    ]);
  }
}, 30_000);
afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function compose(sources: string[], destination = "combined.crt") {
  const init = workloads({ computeControl: compute })[0].spec.template.spec.initContainers[0];
  return spawnSync(
    process.execPath,
    [
      "-e",
      init.command[2],
      join(directory, destination),
      ...sources.map((source) => join(directory, source)),
    ],
    { encoding: "utf8" },
  );
}

test("actual rendered initializer fixes two-CA trust while rejecting unrelated roots and wrong hostnames", async () => {
  const servers = ["compute", "telemetry", "untrusted"].map((name) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: {
        key: readFileSync(join(directory, `${name}.key`)),
        cert: readFileSync(join(directory, `${name}.crt`)),
      },
      fetch: () => new Response("authenticated endpoint", { status: 401 }),
    }),
  );
  const env = { ...process.env };
  for (const key of [
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])
    delete env[key];
  async function accepts(ca: string, index: number, host = "localhost") {
    const script = `try { const r = await fetch(${JSON.stringify(`https://${host}:${servers[index]!.port}`)}, {signal: AbortSignal.timeout(3000)}); process.exit(r.status === 401 ? 0 : 2); } catch { process.exit(23); }`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...env, NODE_EXTRA_CA_CERTS: join(directory, ca) },
      stdout: "ignore",
      stderr: "pipe",
    });
    await new Response(child.stderr).text();
    return (await child.exited) === 0;
  }
  try {
    expect(await accepts("compute-ca.crt", 0)).toBe(true);
    expect(await accepts("compute-ca.crt", 1)).toBe(false);
    expect(compose(["compute-ca.crt", "telemetry-ca.crt"]).status).toBe(0);
    // Init retries in the same Pod can rebuild their own output safely.
    expect(compose(["compute-ca.crt", "telemetry-ca.crt"]).status).toBe(0);
    expect(statSync(join(directory, "combined.crt")).mode & 0o777).toBe(0o444);
    expect(await accepts("combined.crt", 0)).toBe(true);
    expect(await accepts("combined.crt", 1)).toBe(true);
    expect(await accepts("combined.crt", 2)).toBe(false);
    expect(await accepts("combined.crt", 1, "127.0.0.1")).toBe(false);
  } finally {
    for (const server of servers) server.stop(true);
  }
}, 30_000);

test("missing, empty, malformed, oversized and leaf-only inputs fail before application startup", () => {
  expect(compose(["compute-ca.crt", "telemetry-ca.crt"]).status).toBe(0);
  writeFileSync(join(directory, "empty.crt"), "");
  writeFileSync(
    join(directory, "malformed.crt"),
    "-----BEGIN CERTIFICATE-----\nbad\n-----END CERTIFICATE-----",
  );
  writeFileSync(join(directory, "large.crt"), " ".repeat(1_048_577));
  for (const source of [
    "missing.crt",
    "empty.crt",
    "malformed.crt",
    "large.crt",
    "telemetry.crt",
  ]) {
    const result = compose(["compute-ca.crt", source], `failed-${source}`);
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(join(directory, `failed-${source}`))).toThrow();
    const before = readFileSync(join(directory, "combined.crt"), "utf8");
    expect(compose(["compute-ca.crt", source]).status).not.toBe(0);
    expect(readFileSync(join(directory, "combined.crt"), "utf8")).toBe(before);
  }
});
