import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const chart = resolve(import.meta.dir, "..");
const helm = Bun.which("helm");
type Resource = {
  kind: string;
  metadata: { name: string };
  spec?: { template?: { spec: { containers: Array<{ name: string; args?: string[] }> } } };
};

async function render(values: Record<string, unknown>) {
  if (!helm) throw new Error("helm is required for postgres parameter tests");
  const child = Bun.spawn([helm, "template", "pg-test", chart, "-f", "-"], {
    stdin: new Blob([JSON.stringify(values)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, err, resources: parseAllDocuments(out).map((d) => d.toJS() as Resource) };
}

function postgresArgs(resources: Resource[]) {
  const statefulSet = resources.find(
    (resource) => resource?.kind === "StatefulSet" && resource.metadata.name.endsWith("-postgres"),
  );
  const container = statefulSet?.spec?.template?.spec.containers.find((c) => c.name === "postgres");
  if (!container) throw new Error("embedded postgres container not rendered");
  return container.args;
}

describe("embedded postgres server parameters", () => {
  test.skipIf(!helm)("keeps image defaults when no parameters are set", async () => {
    const { code, err, resources } = await render({ postgres: { enabled: true } });
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(postgresArgs(resources)).toBeUndefined();
  });

  test.skipIf(!helm)("renders each parameter as a -c flag in name order", async () => {
    const { code, resources } = await render({
      postgres: {
        enabled: true,
        parameters: {
          shared_preload_libraries: "pg_stat_statements",
          max_connections: 200,
          "pg_stat_statements.track": "top",
          jit: "off",
        },
      },
    });
    expect(code).toBe(0);
    expect(postgresArgs(resources)).toEqual([
      "-c",
      "jit=off",
      "-c",
      "max_connections=200",
      "-c",
      "pg_stat_statements.track=top",
      "-c",
      "shared_preload_libraries=pg_stat_statements",
    ]);
  });

  test.skipIf(!helm)("rejects a name that could smuggle another flag", async () => {
    const { code, err } = await render({
      postgres: { enabled: true, parameters: { "work_mem=1GB -c fsync": "off" } },
    });
    expect(code).not.toBe(0);
    expect(err).toContain("is not a valid PostgreSQL setting name");
  });
});
