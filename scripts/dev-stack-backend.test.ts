import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const backendPath = new URL("./dev-stack-backend.sh", import.meta.url).pathname;
const nativeInfraPath = new URL("./dev-native-infra.sh", import.meta.url).pathname;
const devStackPath = new URL("./dev-stack.sh", import.meta.url).pathname;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function resolveBackend(
  requested: string | undefined,
  dockerExitCode: number,
  fileBackend?: string,
  dockerDelaySeconds = 0,
) {
  const root = await mkdtemp(join(tmpdir(), "opengeni-backend-"));
  temporaryRoots.push(root);
  const docker = join(root, "docker");
  await writeFile(
    docker,
    `#!/bin/sh
[ "\${1:-}" = info ] || exit 99
${dockerDelaySeconds ? `sleep ${dockerDelaySeconds}` : ""}
exit ${dockerExitCode}
`,
  );
  await chmod(docker, 0o755);
  const dotenv = join(root, ".env");
  if (fileBackend !== undefined) await writeFile(dotenv, `OPENGENI_DEV_BACKEND=${fileBackend}\n`);
  const env: Record<string, string | undefined> = {
    ...Bun.env,
    PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin`,
    OPENGENI_DOCKER_PROBE_TIMEOUT_SECONDS: "1",
  };
  if (requested === undefined) delete env.OPENGENI_DEV_BACKEND;
  else env.OPENGENI_DEV_BACKEND = requested;
  const child = Bun.spawn(
    [
      "bash",
      "-c",
      'set -eu; source "$1"; if [ -f "$2" ]; then opengeni_load_dev_environment "$2"; fi; opengeni_resolve_dev_backend',
      "bash",
      backendPath,
      dotenv,
    ],
    {
      env,
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
  test("explicit Docker cannot silently become native through dotenv auto", async () => {
    const result = await resolveBackend("docker", 1, "auto");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Docker daemon is unavailable");
    expect(result.stdout).not.toContain("native");
  });

  test("explicit native wins over a file Docker setting", async () => {
    const result = await resolveBackend("native", 0, "docker");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("native");
  });

  test("unset invocation retains the configured file backend", async () => {
    const result = await resolveBackend(undefined, 0, "native");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("native");
  });

  test("explicit auto remains automatic even when the file requests Docker", async () => {
    const result = await resolveBackend("auto", 1, "docker");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("native");
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

  test("a hung Docker probe is bounded without GNU timeout", async () => {
    const started = Date.now();
    const result = await resolveBackend("auto", 0, undefined, 3);
    expect(result.stdout.trim()).toBe("native");
    expect(Date.now() - started).toBeLessThan(2500);
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

  test("the full launcher resolves native storage before selecting ports and credentials", async () => {
    const source = await Bun.file(devStackPath).text();
    expect(source).toContain("opengeni_load_dev_environment ./.env");
    expect(source).toContain('OPENGENI_DEV_BACKEND="$(opengeni_resolve_dev_backend)"');
    expect(source).toContain("OPENGENI_SANDBOX_BACKEND=local");
    expect(source).not.toContain("OPENGENI_OBJECT_STORAGE_FIXTURE=minio");
    expect(source).toContain("bun scripts/dev-native-storage.ts resolve");
    expect(source.indexOf("bun scripts/dev-native-storage.ts resolve")).toBeLessThan(
      source.indexOf("choose_port OPENGENI_GARAGE_HOST_PORT"),
    );
    expect(source).toContain("choose_port OPENGENI_GARAGE_RPC_HOST_PORT 3901");
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
