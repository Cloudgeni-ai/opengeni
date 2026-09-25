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

async function resolveBindHost(requested: string | undefined) {
  const env: Record<string, string | undefined> = { ...Bun.env };
  if (requested === undefined) delete env.OPENGENI_DEV_BIND_HOST;
  else env.OPENGENI_DEV_BIND_HOST = requested;
  const child = Bun.spawn(
    ["bash", "-c", 'set -eu; source "$1"; opengeni_resolve_dev_bind_host', "bash", backendPath],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr };
}

async function runBackendFunction(
  name: string,
  args: string[],
  environment: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = { ...Bun.env };
  delete env.OPENGENI_MCP_URL;
  Object.assign(env, environment);
  const child = Bun.spawn(
    ["bash", "-c", `set -eu; source "$1"; shift; ${name} "$@"`, "bash", backendPath, ...args],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exitCode).toBe(0);
  return stdout.trim();
}

async function sandboxBridgeMode(
  bindHost: string,
  sandboxBackend: string,
  hostOs: string,
  infrastructure: string,
  mcpUrl?: string,
) {
  return await runBackendFunction(
    "opengeni_dev_sandbox_bridge_mode",
    [bindHost, sandboxBackend, hostOs, infrastructure],
    mcpUrl === undefined ? {} : { OPENGENI_MCP_URL: mcpUrl },
  );
}

describe("development network exposure", () => {
  test("announces network exposure only for the explicit opt-in", async () => {
    expect(await runBackendFunction("opengeni_dev_bind_host_notice", ["0.0.0.0"])).toContain(
      "accept connections from your network",
    );
    expect(await runBackendFunction("opengeni_dev_bind_host_notice", ["127.0.0.1"])).toBe("");
  });

  test("routes Linux Docker Engine sandboxes to the API through their bridge only", async () => {
    // Loopback API: publish the sandbox routes on the Compose network gateway.
    expect(await sandboxBridgeMode("127.0.0.1", "docker", "Linux", "docker")).toBe("forward");
    // The API already listens on every interface; only point sandboxes at it.
    expect(await sandboxBridgeMode("0.0.0.0", "docker", "Linux", "docker")).toBe("direct");
    // Docker Desktop forwards host.docker.internal to the loopback API.
    expect(await sandboxBridgeMode("127.0.0.1", "docker", "Darwin", "docker")).toBe("none");
    // No Docker sandbox, or native infrastructure (which rewrites docker to local).
    expect(await sandboxBridgeMode("127.0.0.1", "local", "Linux", "docker")).toBe("none");
    expect(await sandboxBridgeMode("127.0.0.1", "docker", "Linux", "native")).toBe("none");
    // An explicit sandbox-reachable route is authoritative ...
    expect(
      await sandboxBridgeMode(
        "127.0.0.1",
        "docker",
        "Linux",
        "docker",
        "https://tunnel.example/v1/workspaces/{workspaceId}/mcp",
      ),
    ).toBe("none");
    // ... but a copied loopback or Docker Desktop value cannot reach the host.
    for (const copied of [
      "http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp",
      "http://localhost:8000/v1/workspaces/{workspaceId}/mcp",
      "http://host.docker.internal:8000/v1/workspaces/{workspaceId}/mcp",
    ]) {
      expect(await sandboxBridgeMode("127.0.0.1", "docker", "Linux", "docker", copied)).toBe(
        "forward",
      );
    }
  });

  test("the launcher keeps its printed loopback web URL an allowed browser origin", async () => {
    const source = await Bun.file(devStackPath).text();
    const start = source.indexOf('local_web_origin="http://127.0.0.1:${OPENGENI_WEB_PORT}"');
    const end = source.indexOf("export OPENGENI_LOCAL_ALLOWED_ORIGINS", start);
    expect(start).toBeGreaterThan(source.indexOf("choose_port OPENGENI_WEB_PORT 3000"));
    const snippet = source.slice(start, end);
    const merge = async (existing?: string) => {
      const env: Record<string, string | undefined> = { ...Bun.env, OPENGENI_WEB_PORT: "3001" };
      if (existing === undefined) delete env.OPENGENI_LOCAL_ALLOWED_ORIGINS;
      else env.OPENGENI_LOCAL_ALLOWED_ORIGINS = existing;
      const child = Bun.spawn(
        ["bash", "-c", `set -eu\n${snippet}\nprintf '%s' "$OPENGENI_LOCAL_ALLOWED_ORIGINS"`],
        { env, stdout: "pipe" },
      );
      expect(await child.exited).toBe(0);
      return await new Response(child.stdout).text();
    };
    expect(await merge()).toBe("http://127.0.0.1:3001");
    expect(await merge("http://127.0.0.1:5173")).toBe(
      "http://127.0.0.1:5173,http://127.0.0.1:3001",
    );
    expect(await merge("http://127.0.0.1:3001,http://127.0.0.1:5173")).toBe(
      "http://127.0.0.1:3001,http://127.0.0.1:5173",
    );
    expect(source).toContain(
      "printf 'OPENGENI_LOCAL_ALLOWED_ORIGINS=%s\\n' \"${OPENGENI_LOCAL_ALLOWED_ORIGINS}\"",
    );
  });

  test("the launcher publishes the route after the Compose network exists and before the API starts", async () => {
    const source = await Bun.file(devStackPath).text();
    const resolve = source.indexOf(
      'bun scripts/dev-sandbox-bridge.ts resolve "$OPENGENI_DOCKER_NETWORK"',
    );
    expect(resolve).toBeGreaterThan(
      source.indexOf("docker compose up -d postgres nats temporal garage"),
    );
    expect(resolve).toBeLessThan(source.indexOf("(cd apps/api && bun run dev) &"));
    expect(source).toContain('register_process "$sandbox_bridge_pid" "Docker sandbox route"');
    expect(source).toContain('OPENGENI_SANDBOX_BRIDGE_PORT="$OPENGENI_API_PORT"');
    expect(source).toContain(
      'OPENGENI_SANDBOX_BRIDGE_API_ORIGIN="http://127.0.0.1:${OPENGENI_API_PORT}"',
    );
    expect(source).toContain(
      'export OPENGENI_MCP_URL="${sandbox_bridge_origin}/v1/workspaces/{workspaceId}/mcp"',
    );
    expect(source).toContain(
      "printf 'OPENGENI_MCP_URL=%s\\n' \"${OPENGENI_MCP_URL}\" >>.env.runtime",
    );
  });

  test("binds loopback unless 0.0.0.0 is explicitly requested", async () => {
    expect(await resolveBindHost(undefined)).toMatchObject({ exitCode: 0, stdout: "127.0.0.1" });
    expect(await resolveBindHost("")).toMatchObject({ exitCode: 0, stdout: "127.0.0.1" });
    expect(await resolveBindHost("0.0.0.0")).toMatchObject({ exitCode: 0, stdout: "0.0.0.0" });
    const invalid = await resolveBindHost("192.168.1.20");
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain(
      "OPENGENI_DEV_BIND_HOST must be 127.0.0.1 (default) or 0.0.0.0",
    );
  });

  test("the API, web app, and published infrastructure ports use that bind host", async () => {
    const source = await Bun.file(devStackPath).text();
    expect(source).toContain('OPENGENI_DEV_BIND_HOST="$(opengeni_resolve_dev_bind_host)"');
    expect(source).toContain('OPENGENI_API_HOST="$OPENGENI_DEV_BIND_HOST"');
    expect(source).toContain('opengeni_dev_bind_host_notice "$OPENGENI_DEV_BIND_HOST" >&2');
    expect(source).toContain('--host "${OPENGENI_DEV_BIND_HOST}"');
    expect(source).not.toContain("--host 0.0.0.0");
    for (const setting of ["OPENGENI_DEV_BIND_HOST", "OPENGENI_API_HOST"])
      expect(source).toContain(`printf '${setting}=%s\\n'`);
    expect(source.indexOf("opengeni_resolve_dev_bind_host")).toBeLessThan(
      source.indexOf("docker compose up -d"),
    );

    const web = JSON.parse(
      await Bun.file(new URL("../apps/web/package.json", import.meta.url)).text(),
    );
    expect(web.scripts.dev).not.toContain("--host");

    const compose = Bun.YAML.parse(
      await Bun.file(new URL("../docker-compose.yml", import.meta.url)).text(),
    ) as { services: Record<string, { ports?: string[] }> };
    const published = Object.values(compose.services).flatMap((service) => service.ports ?? []);
    expect(published.length).toBeGreaterThan(0);
    for (const port of published) expect(port).toStartWith("${OPENGENI_DEV_BIND_HOST:-127.0.0.1}:");
  });
});
