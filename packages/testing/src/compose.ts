import { migrate } from "@infra-agents/db/migrate";
import { Connection } from "@temporalio/client";
import { connect as connectNats } from "nats";
import postgres from "postgres";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  natsUrl: string;
  temporalHost: string;
  objectStorageEndpoint?: string;
  objectStorageSandboxEndpoint?: string;
  migrate: () => Promise<void>;
  down: () => Promise<void>;
};

export async function startTestServices(options: { temporal?: boolean; objectStorage?: boolean } = {}): Promise<TestServices> {
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

async function startTestServicesAttempt(options: { temporal?: boolean; objectStorage?: boolean } = {}): Promise<TestServices> {
  const cwd = await makeTempDir("infra-agents-compose-");
  const projectName = `infra_agents_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const ports = {
    postgres: await freePort(),
    nats: await freePort(),
    natsMonitor: await freePort(),
    temporal: await freePort(),
    minio: await freePort(),
    minioConsole: await freePort(),
  };
  const composeFile = join(cwd, "compose.yml");
  await writeFile(composeFile, composeYaml(ports, {
    temporal: options.temporal ?? true,
    objectStorage: options.objectStorage ?? false,
  }));
  const up = await runCommand(["docker", "compose", "-p", projectName, "-f", composeFile, "up", "-d"], { timeoutMs: 180_000 });
  if (up.exitCode !== 0) {
    await runCommand(["docker", "compose", "-p", projectName, "-f", composeFile, "down", "-v", "--remove-orphans"], { timeoutMs: 60_000 }).catch(() => undefined);
    await removeTempDir(cwd);
    throw new Error(`docker compose up failed\n${up.stdout}\n${up.stderr}`);
  }

  const services: TestServices = {
    projectName,
    cwd,
    composeFile,
    postgresPort: ports.postgres,
    natsPort: ports.nats,
    natsMonitorPort: ports.natsMonitor,
    temporalPort: ports.temporal,
    ...(options.objectStorage ? { minioPort: ports.minio, minioConsolePort: ports.minioConsole } : {}),
    databaseUrl: `postgres://infra_agents:infra_agents@127.0.0.1:${ports.postgres}/infra_agents`,
    natsUrl: `nats://127.0.0.1:${ports.nats}`,
    temporalHost: `127.0.0.1:${ports.temporal}`,
    ...(options.objectStorage ? {
      objectStorageEndpoint: `http://127.0.0.1:${ports.minio}`,
      objectStorageSandboxEndpoint: `http://host.docker.internal:${ports.minio}`,
    } : {}),
    migrate: async () => {
      await migrate(services.databaseUrl);
    },
    down: async () => {
      await runCommand(["docker", "compose", "-p", projectName, "-f", composeFile, "down", "-v", "--remove-orphans"], { timeoutMs: 60_000 }).catch(() => undefined);
      await removeTempDir(cwd);
    },
  };

  try {
    await waitForPostgres(services.databaseUrl);
    await waitForNats(services.natsUrl);
    if (options.temporal ?? true) {
      await waitForTemporal(services.temporalHost);
    }
    if (options.objectStorage ?? false) {
      await waitForMinio(services.objectStorageEndpoint!);
      const bucket = await runCommand(["docker", "compose", "-p", projectName, "-f", composeFile, "run", "--rm", "minio-init"], { timeoutMs: 60_000 });
      if (bucket.exitCode !== 0) {
        throw new Error(`minio bucket bootstrap failed\n${bucket.stdout}\n${bucket.stderr}`);
      }
    }
    return services;
  } catch (error) {
    const logs = await composeLogs(projectName, composeFile);
    await services.down();
    throw new Error(`test services failed to become ready: ${error instanceof Error ? error.message : String(error)}\n${logs}`);
  }
}

function isRetryableComposeStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("address already in use") ||
    message.includes("port is already allocated") ||
    message.includes("failed to bind host port");
}

export async function buildSandboxImage(tag = "infra-agents-sandbox:local", cwd = process.cwd()): Promise<void> {
  const result = await runCommand(["docker", "build", "-f", "docker/sandbox.Dockerfile", "-t", tag, "."], {
    cwd,
    timeoutMs: 300_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`sandbox image build failed\n${result.stdout}\n${result.stderr}`);
  }
}

async function waitForPostgres(databaseUrl: string): Promise<void> {
  await waitFor(async () => {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql`select 1`;
      return true;
    } finally {
      await sql.end().catch(() => undefined);
    }
  }, { timeoutMs: 90_000, intervalMs: 500 });
}

async function waitForNats(natsUrl: string): Promise<void> {
  await waitFor(async () => {
    const nc = await connectNats({ servers: natsUrl, timeout: 1_000 });
    await nc.drain();
    return true;
  }, { timeoutMs: 60_000, intervalMs: 500 });
}

async function waitForTemporal(address: string): Promise<void> {
  await waitFor(async () => {
    const connection = await Connection.connect({ address, connectTimeout: 1_000 });
    try {
      await connection.workflowService.describeNamespace({ namespace: "default" });
      await connection.workflowService.countWorkflowExecutions({ namespace: "default" });
      return true;
    } finally {
      await connection.close();
    }
  }, { timeoutMs: 240_000, intervalMs: 1_000 });
}

async function composeLogs(projectName: string, composeFile: string): Promise<string> {
  const result = await runCommand(["docker", "compose", "-p", projectName, "-f", composeFile, "logs", "--no-color"], {
    timeoutMs: 30_000,
  }).catch((error) => ({ stdout: "", stderr: String(error) }));
  return `${result.stdout}\n${result.stderr}`;
}

export async function freePort(): Promise<number> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
    },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitForMinio(endpoint: string): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(`${endpoint}/minio/health/ready`).catch(() => null);
    return response?.ok === true;
  }, { timeoutMs: 90_000, intervalMs: 500 });
}

function composeYaml(ports: { postgres: number; nats: number; natsMonitor: number; temporal: number; minio: number; minioConsole: number }, options: { temporal: boolean; objectStorage: boolean }): string {
  return `services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: infra_agents
      POSTGRES_USER: infra_agents
      POSTGRES_PASSWORD: infra_agents
    ports:
      - "127.0.0.1:${ports.postgres}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U infra_agents -d infra_agents"]
      interval: 2s
      timeout: 5s
      retries: 40

  nats:
    image: nats:2-alpine
    command: ["-m", "8222"]
    ports:
      - "127.0.0.1:${ports.nats}:4222"
      - "127.0.0.1:${ports.natsMonitor}:8222"

${options.temporal ? `  temporal:
    image: temporalio/auto-setup:1.28
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: infra_agents
      POSTGRES_PWD: infra_agents
      POSTGRES_SEEDS: postgres
      BIND_ON_IP: 0.0.0.0
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:${ports.temporal}:7233"
` : ""}
${options.objectStorage ? `  minio:
    image: minio/minio:latest
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
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: ["/bin/sh", "-c"]
    command: >
      "mc alias set local http://minio:9000 minioadmin minioadmin &&
       mc mb --ignore-existing local/infra-agents-files"
` : ""}
`;
}
