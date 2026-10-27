import { describe, expect, test } from "bun:test";
import { parseAllDocuments } from "yaml";
import { resolve } from "node:path";

const chart = resolve(import.meta.dir, "..");
const helm = Bun.which("helm");

type EnvVar = { name: string; value?: string };
type Container = { name: string; env?: EnvVar[]; volumeMounts?: Array<Record<string, unknown>> };
type Pod = { containers: Container[]; volumes?: Array<Record<string, unknown>> };
type Manifest = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec?: { template?: { spec: Pod }; jobTemplate?: { spec: { template: { spec: Pod } } } };
};

async function render(values: Record<string, unknown> = {}) {
  if (!helm) throw new Error("helm is required for chart render tests");
  const child = Bun.spawn([helm, "template", "rotation-test", chart, "-f", "-"], {
    stdin: new Blob([JSON.stringify(values)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function pods(values: Record<string, unknown> = {}): Promise<Map<string, Pod>> {
  const { stdout, stderr, exitCode } = await render(values);
  if (exitCode !== 0) throw new Error(`helm template failed: ${stderr}`);
  const result = new Map<string, Pod>();
  for (const document of parseAllDocuments(stdout, { version: "1.1" })) {
    const manifest = document.toJS() as Manifest | null;
    const pod = manifest?.spec?.template?.spec ?? manifest?.spec?.jobTemplate?.spec.template.spec;
    if (!manifest || !pod) continue;
    result.set(
      manifest.metadata.labels?.["app.kubernetes.io/component"] ?? manifest.metadata.name,
      pod,
    );
  }
  return result;
}

const RUNTIME = ["api", "worker-control", "worker-turns"] as const;
const enabledValues = {
  runtimeDatabasePasswordFiles: { enabled: true },
  relay: { enabled: true },
};

describe("runtime database password files", () => {
  test.skipIf(!helm)("are off by default: no volume, mount or file env", async () => {
    const rendered = await render({ relay: { enabled: true } });
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).not.toContain("runtime-database-password");
    expect(rendered.stdout).not.toContain("OPENGENI_DATABASE_PASSWORD_FILE");
    expect(rendered.stdout).not.toContain("/var/run/opengeni/database");
  });

  test.skipIf(!helm)(
    "mount two optional runtime Secret keys as a read-only directory into the runtime pods",
    async () => {
      const rendered = await pods(enabledValues);
      for (const component of RUNTIME) {
        const pod = rendered.get(component)!;
        expect(pod).toBeDefined();
        expect(pod.volumes).toContainEqual({
          name: "runtime-database-password",
          secret: {
            secretName: "opengeni-runtime",
            optional: true,
            defaultMode: 0o444,
            items: [
              { key: "OPENGENI_DATABASE_PASSWORD", path: "password" },
              { key: "OPENGENI_DATABASE_PREVIOUS_PASSWORD", path: "previous-password" },
            ],
          },
        });
        const container = pod.containers[0]!;
        // A directory mount, never subPath: subPath mounts miss kubelet updates.
        expect(container.volumeMounts).toContainEqual({
          name: "runtime-database-password",
          mountPath: "/var/run/opengeni/database",
          readOnly: true,
        });
        expect(
          container.volumeMounts!.filter(
            (mount) => "subPath" in mount && mount.name === "runtime-database-password",
          ),
        ).toEqual([]);
        expect(container.env).toContainEqual({
          name: "OPENGENI_DATABASE_PASSWORD_FILE",
          value: "/var/run/opengeni/database/password",
        });
        expect(container.env).toContainEqual({
          name: "OPENGENI_DATABASE_PREVIOUS_PASSWORD_FILE",
          value: "/var/run/opengeni/database/previous-password",
        });
      }
      // No other workload gets the runtime login's password files: the relay
      // has no database, and jobs and dedicated services use their own logins.
      for (const [component, pod] of rendered) {
        if ((RUNTIME as readonly string[]).includes(component)) continue;
        expect(JSON.stringify(pod)).not.toContain("runtime-database-password");
        expect(JSON.stringify(pod)).not.toContain("OPENGENI_DATABASE_PASSWORD_FILE");
      }
      expect(rendered.has("relay")).toBe(true);
    },
  );

  test.skipIf(!helm)("can name another Secret", async () => {
    const rendered = await pods({
      runtimeDatabasePasswordFiles: { enabled: true, secretName: "opengeni-db-password" },
    });
    for (const component of RUNTIME) {
      expect(rendered.get(component)!.volumes).toContainEqual(
        expect.objectContaining({
          name: "runtime-database-password",
          secret: expect.objectContaining({ secretName: "opengeni-db-password", optional: true }),
        }),
      );
    }
  });

  test.skipIf(!helm)("extraEnv cannot override the chart-owned file paths", async () => {
    const rendered = await render({
      runtimeDatabasePasswordFiles: { enabled: true },
      api: { extraEnv: [{ name: "OPENGENI_DATABASE_PASSWORD_FILE", value: "/tmp/x" }] },
    });
    expect(rendered.exitCode).not.toBe(0);
    expect(rendered.stderr).toContain("extraEnv cannot repeat a variable");
  });
});
