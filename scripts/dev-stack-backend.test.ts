import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const backendPath = new URL("./dev-stack-backend.sh", import.meta.url).pathname;
const nativeInfraPath = new URL("./dev-native-infra.sh", import.meta.url).pathname;
const devStackPath = new URL("./dev-stack.sh", import.meta.url).pathname;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function resolveBackend(requested: string, dockerExitCode: number, delay = false) {
  const root = await mkdtemp(join(tmpdir(), "opengeni-backend-"));
  temporaryRoots.push(root);
  const docker = join(root, "docker");
  await writeFile(
    docker,
    `#!/bin/sh
[ "\${1:-}" = info ] || exit 99
echo 'fixture Docker diagnostic' >&2
${delay ? "sleep 5" : ""}
exit ${dockerExitCode}
`,
  );
  await chmod(docker, 0o755);
  const child = Bun.spawn(
    ["bash", "-c", 'source "$1"; opengeni_resolve_dev_backend', "bash", backendPath],
    {
      env: {
        ...Bun.env,
        PATH: `${root}:/usr/bin:/bin`,
        OPENGENI_DEV_BACKEND: requested,
        OPENGENI_DOCKER_PROBE_TIMEOUT_SECONDS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("development infrastructure backend", () => {
  test.each(["docker", "native", "auto", undefined])(
    "the startup shell preserves caller backend %s over a copied env default",
    async (requested) => {
      const root = await mkdtemp(join(tmpdir(), "opengeni-backend-env-"));
      temporaryRoots.push(root);
      await mkdir(join(root, "scripts"));
      await copyFile(devStackPath, join(root, "scripts/dev-stack.sh"));
      await copyFile(new URL("../.env.example", import.meta.url), join(root, ".env.example"));
      // Stop at the selection boundary, before credentials or infrastructure.
      await writeFile(
        join(root, "scripts/dev-stack-backend.sh"),
        'opengeni_resolve_dev_backend() { echo "selected=$OPENGENI_DEV_BACKEND" >&2; return 42; }\n',
      );
      const env = { ...Bun.env };
      delete env.OPENGENI_DEV_BACKEND;
      if (requested !== undefined) env.OPENGENI_DEV_BACKEND = requested;
      const child = Bun.spawn(
        ["bash", join(root, "scripts/dev-stack.sh"), "--opengeni-dev-stack-token=fixture"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(exitCode).toBe(42);
      expect(stderr.trim()).toBe(`selected=${requested ?? "auto"}`);
    },
  );

  test("failed probes retain their exit status and Docker diagnostic", async () => {
    const result = await resolveBackend("auto", 7);
    expect(result.stdout.trim()).toBe("native");
    expect(result.stderr).toContain("fixture Docker diagnostic");
    expect(result.stderr).toContain("exit 7");
  });

  test("a timed-out probe is distinguishable from a Docker error", async () => {
    const result = await resolveBackend("docker", 0, true);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("exit 124");
    expect(result.stderr).toContain("1s");
  });

  test("auto chooses native when a Docker client cannot reach its daemon", async () => {
    const result = await resolveBackend("auto", 1);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("native");
  });

  test("auto keeps Docker when its daemon is reachable", async () => {
    const result = await resolveBackend("auto", 0);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("docker");
  });

  test("an explicit Docker request fails closed without a daemon", async () => {
    const result = await resolveBackend("docker", 1);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Docker daemon is unavailable");
  });

  test("native infrastructure is project-scoped and protects process identity", async () => {
    const source = await Bun.file(nativeInfraPath).text();
    expect(source).toContain(".opengeni/native/${COMPOSE_PROJECT_NAME}");
    expect(source).toContain("awk '{print $22}' \"/proc/$pid/stat\"");
    expect(source).toContain('[ "$actual_start" = "$expected_start" ]');
    expect(source).toContain("temporal server start-dev");
    expect(source).toContain('mc --config-dir "$MC_CONFIG_DIR" mb --ignore-existing');
    expect(source).toContain('case "$STATE_DIR" in');
    expect(source).toContain(
      'OPENGENI_NATS_CONFIG_FILE="${OPENGENI_NATS_CONFIG_FILE:-$(pwd)/deploy/nats/local-development.conf}"',
    );
    expect(source).toContain(
      'OPENGENI_TEMPORAL_UI_HOST_PORT="${OPENGENI_TEMPORAL_UI_HOST_PORT:-8233}"',
    );
  });

  test("the full launcher records native backend, sandbox, and MinIO authority", async () => {
    const source = await Bun.file(devStackPath).text();
    expect(source).toContain('OPENGENI_DEV_BACKEND="$(opengeni_resolve_dev_backend)"');
    expect(source).toContain("OPENGENI_SANDBOX_BACKEND=local");
    expect(source).toContain("OPENGENI_OBJECT_STORAGE_FIXTURE=minio");
    expect(source).toContain("bash scripts/dev-native-infra.sh status --quiet");
    expect(source).toContain("bash scripts/dev-native-infra.sh start");
    expect(source).toContain(
      'export OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT="${OPENGENI_OBJECT_STORAGE_ENDPOINT}"',
    );
    for (const setting of [
      "OPENGENI_DEV_BACKEND",
      "OPENGENI_SANDBOX_BACKEND",
      "OPENGENI_OBJECT_STORAGE_BACKEND",
      "OPENGENI_OBJECT_STORAGE_BUCKET",
      "OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE",
    ]) {
      expect(source).toContain(`printf '${setting}=%s\\n'`);
    }
  });
});
