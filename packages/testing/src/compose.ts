import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { Connection } from "@temporalio/client";
import { connect as connectNats } from "nats";
import postgres from "postgres";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir, runCommand, waitFor } from "./process";

export type TestServices = {
  projectName: string;
  cwd: string;
  composeFile: string;
  postgresPort: number;
  natsPort: number;
  natsMonitorPort: number;
  temporalPort: number;
  minioPort?: number;
  minioConsolePort?: number;
  databaseUrl: string;
  /** Restricted opengeni_app URL for starting API/worker entry points. */
  runtimeDatabaseUrl: string;
  natsUrl: string;
  temporalHost: string;
  dockerNetwork: string;
  objectStorageEndpoint?: string;
  objectStorageSandboxEndpoint?: string;
  migrate: () => Promise<void>;
  down: () => Promise<void>;
};

export async function startTestServices(
  options: { temporal?: boolean; objectStorage?: boolean } = {},
): Promise<TestServices> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await startTestServicesAttempt(options);
    } catch (error) {
      lastError = error;
      if (!isRetryableComposeStartupError(error) || attempt === 5) {
        throw error;
      }
      await Bun.sleep(100 * attempt);
    }
  }
  throw lastError;
}

async function startTestServicesAttempt(
  options: { temporal?: boolean; objectStorage?: boolean } = {},
): Promise<TestServices> {
  const cwd = await makeTempDir("opengeni-compose-");
  const projectName = `opengeni_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const ports = {
    postgres: await freePort(),
    nats: await freePort(),
    natsMonitor: await freePort(),
    temporal: await freePort(),
    minio: await freePort(),
    minioConsole: await freePort(),
  };
  const composeFile = join(cwd, "compose.yml");
  await writeFile(
    composeFile,
    composeYaml(ports, {
      temporal: options.temporal ?? true,
      objectStorage: options.objectStorage ?? false,
    }),
  );
  const composeUpCommand = [
    // Serialize this contract across worktrees. Shared CI hosts may prune old
    // image digests while another suite is between pull and container create.
    ...(process.platform === "linux"
      ? ["flock", "--exclusive", "--timeout", "120", "/tmp/opengeni-test-compose-images-v1.lock"]
      : []),
    "bun",
    fileURLToPath(new URL("./compose-up.ts", import.meta.url)),
    projectName,
    composeFile,
    JSON.stringify(testServiceImages(options)),
  ];
  const up = await runCommand(composeUpCommand, { timeoutMs: 210_000 });
  if (up.timedOut || up.exitCode !== 0) {
    let cleanupFailure = "";
    try {
      await stopTestServices(projectName, composeFile, cwd);
    } catch (error) {
      cleanupFailure = `\ncompose cleanup also failed: ${String(error)}`;
    }
    throw new Error(
      `docker compose up ${up.timedOut ? "timed out" : "failed"}\n${up.stdout}\n${up.stderr}${cleanupFailure}`,
    );
  }

  let downPromise: Promise<void> | undefined;
  const services: TestServices = {
    projectName,
    cwd,
    composeFile,
    postgresPort: ports.postgres,
    natsPort: ports.nats,
    natsMonitorPort: ports.natsMonitor,
    temporalPort: ports.temporal,
    ...(options.objectStorage
      ? { minioPort: ports.minio, minioConsolePort: ports.minioConsole }
      : {}),
    databaseUrl: `postgres://opengeni:opengeni@127.0.0.1:${ports.postgres}/opengeni`,
    runtimeDatabaseUrl: `postgres://opengeni_app:opengeni_app@127.0.0.1:${ports.postgres}/opengeni`,
    natsUrl: `nats://127.0.0.1:${ports.nats}`,
    temporalHost: `127.0.0.1:${ports.temporal}`,
    dockerNetwork: `${projectName}_default`,
    ...(options.objectStorage
      ? {
          objectStorageEndpoint: `http://127.0.0.1:${ports.minio}`,
          objectStorageSandboxEndpoint: "http://minio:9000",
        }
      : {}),
    migrate: async () => {
      await migrate(services.databaseUrl);
      await provisionRoles(services.databaseUrl, {
        appRole: "opengeni_app",
        appPassword: "opengeni_app",
        rlsStrategy: "force",
      });
    },
    down: () => (downPromise ??= stopTestServices(projectName, composeFile, cwd)),
  };

  try {
    await waitForPostgres(services.databaseUrl);
    await waitForNats(services.natsUrl);
    if (options.temporal ?? true) {
      await waitForTemporal(services.temporalHost);
    }
    if (options.objectStorage ?? false) {
      await waitForMinio(services.objectStorageEndpoint!);
      await bootstrapMinioBucket(projectName, composeFile);
    }
    return services;
  } catch (error) {
    const logs = await composeLogs(projectName, composeFile);
    let cleanupFailure = "";
    try {
      await services.down();
    } catch (cleanupError) {
      cleanupFailure = `\ncompose cleanup also failed: ${String(cleanupError)}`;
    }
    throw new Error(
      `test services failed to become ready: ${error instanceof Error ? error.message : String(error)}\n${logs}${cleanupFailure}`,
      { cause: error },
    );
  }
}

async function stopTestServices(
  projectName: string,
  composeFile: string,
  cwd: string,
): Promise<void> {
  const diagnostics: string[] = [];
  const pinCleanupFailure = await removeTestImagePins(projectName);
  if (pinCleanupFailure) {
    diagnostics.push(pinCleanupFailure);
  }
  const sandboxCleanup = await removeAttachedSandboxContainers(projectName);
  if (sandboxCleanup.note) {
    diagnostics.push(sandboxCleanup.note);
  }
  if (sandboxCleanup.failure) {
    diagnostics.push(sandboxCleanup.failure);
  }
  for (const stopTimeoutSeconds of ["5", "0"] as const) {
    const composeFiles = await composeFileArgs(composeFile);
    const result = await runCommand(
      [
        "docker",
        "compose",
        "-p",
        projectName,
        ...composeFiles,
        "down",
        "--timeout",
        stopTimeoutSeconds,
        "-v",
        "--remove-orphans",
      ],
      { timeoutMs: 30_000 },
    );
    diagnostics.push(
      `down --timeout ${stopTimeoutSeconds}: exit=${result.exitCode} timedOut=${String(result.timedOut)}\n${result.stdout}\n${result.stderr}`,
    );
    if (result.timedOut || result.exitCode !== 0) {
      continue;
    }

    const residue = await testServiceResidue(projectName);
    if (residue.length === 0 && !sandboxCleanup.failure) {
      await removeTempDir(cwd);
      return;
    }
    if (residue.length > 0) {
      diagnostics.push(
        `residue after down --timeout ${stopTimeoutSeconds}:\n${residue.join("\n")}`,
      );
    }
  }

  throw new Error(
    `failed to remove owned test-service project ${projectName}; compose file retained at ${composeFile}\n${diagnostics.join("\n")}`,
  );
}

type AttachedSandboxCleanup = {
  note?: string;
  failure?: string;
};

/**
 * Ownership-mode Docker sandboxes intentionally remain warm after the worker
 * exits. E2E stacks attach those boxes to their one-off Compose network so the
 * box can reach MinIO; leaving one attached makes `docker compose down` retain
 * the network and leaks the box, its generated volume(s), and host workspace.
 *
 * Only remove containers carrying the upstream SDK's explicit ownership label.
 * The Compose network name is random per test run, and every removed filesystem
 * path/volume is additionally constrained to the SDK's generated name contract.
 */
async function removeAttachedSandboxContainers(
  projectName: string,
): Promise<AttachedSandboxCleanup> {
  const network = `${projectName}_default`;
  const list = await runCommand(
    [
      "docker",
      "ps",
      "-aq",
      "--filter",
      `network=${network}`,
      "--filter",
      "label=openai-agents-sandbox=true",
    ],
    { timeoutMs: 5_000 },
  );
  if (list.timedOut || list.exitCode !== 0) {
    return {
      failure: `attached sandbox inspection failed: exit=${list.exitCode} timedOut=${String(list.timedOut)}\n${list.stdout}\n${list.stderr}`,
    };
  }

  const containerIds = list.stdout.trim().split("\n").filter(Boolean);
  if (containerIds.length === 0) {
    return {};
  }

  const workspaceDirs = new Set<string>();
  const volumeNames = new Set<string>();
  for (const containerId of containerIds) {
    const inspect = await runCommand(
      ["docker", "inspect", "--format", "{{json .Mounts}}", containerId],
      { timeoutMs: 5_000 },
    );
    if (inspect.timedOut || inspect.exitCode !== 0) {
      return {
        failure: `attached sandbox mount inspection failed for ${containerId}: exit=${inspect.exitCode} timedOut=${String(inspect.timedOut)}\n${inspect.stdout}\n${inspect.stderr}`,
      };
    }

    let mounts: unknown;
    try {
      mounts = JSON.parse(inspect.stdout.trim());
    } catch (error) {
      return {
        failure: `attached sandbox mount inspection returned invalid JSON for ${containerId}: ${String(error)}`,
      };
    }
    if (!Array.isArray(mounts)) {
      return {
        failure: `attached sandbox mount inspection returned a non-array for ${containerId}`,
      };
    }
    for (const mount of mounts) {
      if (!mount || typeof mount !== "object") continue;
      const record = mount as { Type?: unknown; Source?: unknown; Name?: unknown };
      if (
        record.Type === "bind" &&
        typeof record.Source === "string" &&
        dirname(record.Source) === tmpdir() &&
        record.Source.startsWith(join(tmpdir(), "openai-agents-docker-sandbox-"))
      ) {
        workspaceDirs.add(record.Source);
      }
      if (
        record.Type === "volume" &&
        typeof record.Name === "string" &&
        record.Name.startsWith("openai-agents-sandbox-")
      ) {
        volumeNames.add(record.Name);
      }
    }
  }

  const removeContainers = await runCommand(["docker", "rm", "-f", "-v", ...containerIds], {
    timeoutMs: 30_000,
  });
  if (removeContainers.timedOut || removeContainers.exitCode !== 0) {
    return {
      failure: `attached sandbox removal failed: exit=${removeContainers.exitCode} timedOut=${String(removeContainers.timedOut)}\n${removeContainers.stdout}\n${removeContainers.stderr}`,
    };
  }

  if (volumeNames.size > 0) {
    const removeVolumes = await runCommand(["docker", "volume", "rm", "-f", ...volumeNames], {
      timeoutMs: 15_000,
    });
    if (removeVolumes.timedOut || removeVolumes.exitCode !== 0) {
      return {
        failure: `attached sandbox volume removal failed: exit=${removeVolumes.exitCode} timedOut=${String(removeVolumes.timedOut)}\n${removeVolumes.stdout}\n${removeVolumes.stderr}`,
      };
    }
  }

  try {
    await Promise.all([...workspaceDirs].map((path) => removeTempDir(path)));
  } catch (error) {
    return { failure: `attached sandbox workspace removal failed: ${String(error)}` };
  }

  return {
    note: `removed ${containerIds.length} attached OpenAI sandbox container(s), ${volumeNames.size} generated volume(s), and ${workspaceDirs.size} generated workspace(s) from ${network}`,
  };
}

async function testServiceResidue(projectName: string): Promise<string[]> {
  const filter = `label=com.docker.compose.project=${projectName}`;
  const pinFilter = `label=com.opengeni.test-image-pin=${projectName}`;
  const labels = ["containers", "image pins", "volumes", "networks"] as const;
  const checks = await Promise.allSettled([
    inspectDockerResidue("containers", ["docker", "ps", "-aq", "--filter", filter]),
    inspectDockerResidue("image pins", ["docker", "ps", "-aq", "--filter", pinFilter]),
    inspectDockerResidue("volumes", ["docker", "volume", "ls", "-q", "--filter", filter]),
    inspectDockerResidue("networks", ["docker", "network", "ls", "-q", "--filter", filter]),
  ]);
  return checks
    .map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : `${labels[index]} inspection threw: ${String(result.reason)}`,
    )
    .filter((result): result is string => result !== null);
}

async function removeTestImagePins(projectName: string): Promise<string | null> {
  const list = await runCommand(
    ["docker", "ps", "-aq", "--filter", `label=com.opengeni.test-image-pin=${projectName}`],
    { timeoutMs: 5_000 },
  );
  if (list.timedOut || list.exitCode !== 0) {
    return `image pin inspection failed: exit=${list.exitCode} timedOut=${String(list.timedOut)}\n${list.stdout}\n${list.stderr}`;
  }
  const pins = list.stdout.trim().split("\n").filter(Boolean);
  if (pins.length === 0) {
    return null;
  }

  const remove = await runCommand(["docker", "rm", "-f", "-v", ...pins], {
    timeoutMs: 15_000,
  });
  if (remove.timedOut || remove.exitCode !== 0) {
    return `image pin removal failed: exit=${remove.exitCode} timedOut=${String(remove.timedOut)}\n${remove.stdout}\n${remove.stderr}`;
  }
  return null;
}

async function inspectDockerResidue(label: string, args: string[]): Promise<string | null> {
  const result = await runCommand(args, { timeoutMs: 5_000 });
  if (result.timedOut || result.exitCode !== 0) {
    return `${label} inspection failed: exit=${result.exitCode} timedOut=${String(result.timedOut)}\n${result.stdout}\n${result.stderr}`;
  }
  const ids = result.stdout.trim();
  return ids.length > 0 ? `${label}: ${ids.replaceAll("\n", ", ")}` : null;
}

function testServiceImages(options: {
  temporal?: boolean;
  objectStorage?: boolean;
}): Record<string, string> {
  return {
    postgres: "pgvector/pgvector:pg17",
    nats: "nats:2-alpine",
    ...((options.temporal ?? true) ? { temporal: "temporalio/auto-setup:1.28" } : {}),
    ...((options.objectStorage ?? false)
      ? { minio: "minio/minio:latest", "minio-init": "minio/mc:latest" }
      : {}),
  };
}

function isRetryableComposeStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("address already in use") ||
    message.includes("port is already allocated") ||
    message.includes("failed to bind host port")
  );
}

export async function buildSandboxImage(
  tag = "opengeni-sandbox:local",
  cwd = process.cwd(),
): Promise<void> {
  const result = await runCommand(
    ["docker", "build", "-f", "docker/sandbox.Dockerfile", "-t", tag, "."],
    {
      cwd,
      timeoutMs: 300_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`sandbox image build failed\n${result.stdout}\n${result.stderr}`);
  }
}

/**
 * Run a raw, possibly multi-statement SQL script (e.g. a migration file's full
 * text, including DO $$ ... $$ blocks) against a database. Uses the simple
 * protocol via `unsafe`, the same path the migration runner uses, so a hand-
 * authored .sql file behaves identically in a test. Intended for exercising
 * migration files directly; not for app queries.
 */
export async function applyRawSql(databaseUrl: string, sqlText: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(sqlText);
  } finally {
    await sql.end().catch(() => undefined);
  }
}

async function waitForPostgres(databaseUrl: string): Promise<void> {
  await waitFor(
    async () => {
      const sql = postgres(databaseUrl, { max: 1 });
      try {
        await sql`select 1`;
        return true;
      } finally {
        await sql.end().catch(() => undefined);
      }
    },
    { timeoutMs: 90_000, intervalMs: 500 },
  );
}

async function waitForNats(natsUrl: string): Promise<void> {
  await waitFor(
    async () => {
      const nc = await connectNats({ servers: natsUrl, timeout: 1_000 });
      await nc.drain();
      return true;
    },
    { timeoutMs: 60_000, intervalMs: 500 },
  );
}

async function waitForTemporal(address: string): Promise<void> {
  await waitFor(
    async () => {
      const connection = await Connection.connect({
        address,
        connectTimeout: 1_000,
      });
      try {
        await connection.workflowService.describeNamespace({
          namespace: "default",
        });
        await connection.workflowService.countWorkflowExecutions({
          namespace: "default",
        });
        return true;
      } finally {
        await connection.close();
      }
    },
    { timeoutMs: 240_000, intervalMs: 1_000 },
  );
}

async function composeLogs(projectName: string, composeFile: string): Promise<string> {
  const composeFiles = await composeFileArgs(composeFile);
  const result = await runCommand(
    ["docker", "compose", "-p", projectName, ...composeFiles, "logs", "--no-color"],
    {
      timeoutMs: 30_000,
    },
  ).catch((error) => ({ stdout: "", stderr: String(error) }));
  return `${result.stdout}\n${result.stderr}`;
}

const TEST_LISTENER_PORT_START = 20_000;
const TEST_LISTENER_PORT_END = 29_999;
const issuedTestPorts = new Set<number>();

export async function freePort(): Promise<number> {
  // Port 0 returns a Linux ephemeral client port. Releasing it before a child
  // process binds lets an unrelated outbound connection claim the same port,
  // which can leave Vite or a real test service waiting until timeout. Allocate
  // listeners from a range below the host ephemeral range and never hand the
  // same port out twice in one test process.
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const port =
      TEST_LISTENER_PORT_START +
      Math.floor(Math.random() * (TEST_LISTENER_PORT_END - TEST_LISTENER_PORT_START + 1));
    if (issuedTestPorts.has(port)) continue;
    try {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
        },
      });
      server.stop(true);
      issuedTestPorts.add(port);
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("Unable to reserve a test listener port outside the ephemeral range");
}

async function waitForMinio(endpoint: string): Promise<void> {
  await waitFor(
    async () => {
      const response = await fetch(`${endpoint}/minio/health/ready`, {
        signal: AbortSignal.timeout(2_000),
      }).catch(() => null);
      return response?.ok === true;
    },
    { timeoutMs: 90_000, intervalMs: 500 },
  );
}

async function bootstrapMinioBucket(projectName: string, composeFile: string): Promise<void> {
  let lastResult: Awaited<ReturnType<typeof runCommand>> | null = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const composeFiles = await composeFileArgs(composeFile);
    lastResult = await runCommand(
      ["docker", "compose", "-p", projectName, ...composeFiles, "run", "--rm", "minio-init"],
      { timeoutMs: 60_000 },
    );
    if (lastResult.exitCode === 0) {
      return;
    }
    await Bun.sleep(attempt * 1_000);
  }
  throw new Error(
    `minio bucket bootstrap failed\n${lastResult?.stdout ?? ""}\n${lastResult?.stderr ?? ""}`,
  );
}

async function composeFileArgs(composeFile: string): Promise<string[]> {
  const args = ["-f", composeFile];
  const imageOverrideFile = `${composeFile}.images.json`;
  if (await Bun.file(imageOverrideFile).exists()) {
    args.push("-f", imageOverrideFile);
  }
  return args;
}

function composeYaml(
  ports: {
    postgres: number;
    nats: number;
    natsMonitor: number;
    temporal: number;
    minio: number;
    minioConsole: number;
  },
  options: { temporal: boolean; objectStorage: boolean },
): string {
  return `services:
  postgres:
    image: pgvector/pgvector:pg17
    pull_policy: never
    environment:
      POSTGRES_DB: opengeni
      POSTGRES_USER: opengeni
      POSTGRES_PASSWORD: opengeni
    ports:
      - "127.0.0.1:${ports.postgres}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U opengeni -d opengeni"]
      interval: 2s
      timeout: 5s
      retries: 40

  nats:
    image: nats:2-alpine
    pull_policy: never
    command: ["-m", "8222"]
    ports:
      - "127.0.0.1:${ports.nats}:4222"
      - "127.0.0.1:${ports.natsMonitor}:8222"

${
  options.temporal
    ? `  temporal:
    image: temporalio/auto-setup:1.28
    pull_policy: never
    # pg_isready can briefly report healthy during the official Postgres
    # image's temporary initialization server, immediately before that server
    # shuts down for the final restart. If Temporal lands in that narrow window,
    # auto-setup exits once. Retry it rather than turning host load into a
    # four-minute test-suite flake.
    restart: "on-failure:5"
    environment:
      HTTP_PROXY: ""
      HTTPS_PROXY: ""
      ALL_PROXY: ""
      http_proxy: ""
      https_proxy: ""
      all_proxy: ""
      NO_PROXY: "localhost,127.0.0.1,postgres,temporal,frontend,history,matching,worker"
      no_proxy: "localhost,127.0.0.1,postgres,temporal,frontend,history,matching,worker"
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: opengeni
      POSTGRES_PWD: opengeni
      POSTGRES_SEEDS: postgres
      BIND_ON_IP: 0.0.0.0
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:${ports.temporal}:7233"
`
    : ""
}
${
  options.objectStorage
    ? `  minio:
    image: minio/minio:latest
    pull_policy: never
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "127.0.0.1:${ports.minio}:9000"
      - "127.0.0.1:${ports.minioConsole}:9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:9000/minio/health/ready"]
      interval: 2s
      timeout: 5s
      retries: 40

  minio-init:
    image: minio/mc:latest
    pull_policy: never
    # Keep this one-shot bootstrap out of the initial compose-up. The harness
    # runs it explicitly after MinIO is healthy; including it here as well both
    # creates the bucket twice and can race concurrent image pulls before the
    # Docker daemon has committed the mc tag.
    profiles: ["bootstrap"]
    depends_on:
      minio:
        condition: service_healthy
    environment:
      HTTP_PROXY: ""
      HTTPS_PROXY: ""
      ALL_PROXY: ""
      http_proxy: ""
      https_proxy: ""
      all_proxy: ""
      NO_PROXY: "localhost,127.0.0.1,minio"
      no_proxy: "localhost,127.0.0.1,minio"
    entrypoint: ["/bin/sh", "-c"]
    command: >
      "for i in $$(seq 1 30); do
         mc alias set local http://minio:9000 minioadmin minioadmin &&
         mc mb --ignore-existing local/opengeni-files &&
         exit 0;
         sleep 2;
       done;
       exit 1"
`
    : ""
}
`;
}
