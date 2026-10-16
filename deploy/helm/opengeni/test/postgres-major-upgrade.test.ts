import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const chart = resolve(import.meta.dir, "..");
const script = join(chart, "files/postgres-major-upgrade.sh");
const helm = Bun.which("helm");
const bash = Bun.which("bash");

type Container = {
  name: string;
  image: string;
  env?: Array<{ name: string; value: string }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
};
type Resource = {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  spec?: {
    template?: {
      metadata?: { annotations?: Record<string, string> };
      spec: {
        initContainers?: Container[];
        containers: Container[];
        volumes?: Array<{ name: string; emptyDir?: object; configMap?: { name: string } }>;
      };
    };
  };
};

async function render(values: Record<string, unknown>) {
  if (!helm) throw new Error("helm is required for postgres upgrade tests");
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
  expect(err).toBe("");
  expect(code).toBe(0);
  const resources = parseAllDocuments(out).map((d) => d.toJS() as Resource);
  const statefulSet = resources.find(
    (resource) => resource?.kind === "StatefulSet" && resource.metadata.name.endsWith("-postgres"),
  );
  const configMap = resources.find(
    (resource) =>
      resource?.kind === "ConfigMap" && resource.metadata.name.endsWith("-postgres-upgrade"),
  );
  const pod = statefulSet?.spec?.template;
  if (!pod || !configMap) throw new Error("embedded postgres was not rendered");
  return { pod, configMap };
}

const env = (container: Container | undefined, name: string) =>
  container?.env?.find((entry) => entry.name === name)?.value;

describe("embedded postgres major version", () => {
  test.skipIf(!helm)("defaults to PostgreSQL 18 behind a data-version guard", async () => {
    const { pod, configMap } = await render({ postgres: { enabled: true } });
    const server = pod.spec.containers.find((container) => container.name === "postgres");
    expect(server?.image).toBe("pgvector/pgvector:pg18-bookworm");
    expect(pod.spec.initContainers?.map((container) => container.name)).toEqual([
      "postgres-data-version",
    ]);
    const guard = pod.spec.initContainers?.[0];
    expect(guard?.image).toBe(server?.image);
    expect(env(guard, "OPENGENI_POSTGRES_MAJOR_UPGRADE")).toBe("false");
    expect(env(guard, "PGDATA")).toBe("/var/lib/postgresql/data/pgdata");
    expect(configMap.data?.["postgres-major-upgrade.sh"]).toBe(
      (await readFile(script, "utf8")).trimEnd(),
    );
    expect(pod.metadata?.annotations?.["checksum/postgres-upgrade"]).toMatch(/^[0-9a-f]{64}$/);
    expect(pod.spec.volumes?.some((volume) => volume.name === "postgres-old")).toBe(false);
  });

  test.skipIf(!helm)("an enabled upgrade stages the older binaries first", async () => {
    const { pod } = await render({
      postgres: {
        enabled: true,
        majorUpgrade: { enabled: true, fromImage: { repository: "example/pg", tag: "17" } },
      },
    });
    const [binaries, guard] = pod.spec.initContainers ?? [];
    expect(binaries?.name).toBe("postgres-old-binaries");
    expect(binaries?.image).toBe("example/pg:17");
    expect(binaries?.volumeMounts).toContainEqual({
      name: "data",
      mountPath: "/var/lib/postgresql/data",
      readOnly: true,
    });
    expect(guard?.name).toBe("postgres-data-version");
    expect(env(guard, "OPENGENI_POSTGRES_MAJOR_UPGRADE")).toBe("true");
    expect(guard?.volumeMounts?.map((mount) => mount.name)).toContain("postgres-old");
    expect(pod.spec.volumes).toContainEqual({ name: "postgres-old", emptyDir: {} });
  });

  test.skipIf(!helm)("ephemeral storage still mounts a data volume", async () => {
    const { pod } = await render({ postgres: { enabled: true, persistence: { enabled: false } } });
    expect(pod.spec.volumes).toContainEqual({ name: "data", emptyDir: {} });
  });
});

describe("data-version guard script", () => {
  async function guard(version: string | null, upgrade = "false") {
    if (!bash) throw new Error("bash is required");
    const root = await mkdtemp(join(tmpdir(), "pg-guard-"));
    try {
      const pgdata = join(root, "pgdata");
      if (version !== null) {
        await mkdir(pgdata);
        await writeFile(join(pgdata, "PG_VERSION"), `${version}\n`);
      }
      const child = Bun.spawn([bash, script], {
        env: {
          PATH: process.env.PATH ?? "",
          PGDATA: pgdata,
          PG_MAJOR: "18.1",
          OPENGENI_POSTGRES_MAJOR_UPGRADE: upgrade,
          OPENGENI_POSTGRES_OLD_ROOT: join(root, "old"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      return { code, err };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test.skipIf(!bash)("lets a fresh or same-major directory start", async () => {
    expect((await guard(null)).code).toBe(0);
    expect((await guard("18")).code).toBe(0);
  });

  test.skipIf(!bash)("refuses an older directory unless an upgrade is enabled", async () => {
    const refused = await guard("17");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("postgres.majorUpgrade.enabled=true");
    const missingBinaries = await guard("17", "true");
    expect(missingBinaries.code).toBe(1);
    expect(missingBinaries.err).toContain("did not provide PostgreSQL 17 binaries");
  });

  test.skipIf(!bash)("refuses a newer directory", async () => {
    const refused = await guard("19");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("use an image of at least version 19");
  });
});
