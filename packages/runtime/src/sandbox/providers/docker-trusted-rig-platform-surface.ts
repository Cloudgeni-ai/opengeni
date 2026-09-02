import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExposedPortEndpoint } from "@openai/agents/sandbox";
import type {
  BrowserControlPlacementSession,
  TrustedRigPlatformSurface,
  TrustedRigPlatformSurfaceOperation,
} from "../browser-control-client";
import {
  createTrustedRigPlatformSurface,
  type TrustedRigPlatformSidecar,
  type TrustedRigPlatformSidecarPurpose,
} from "./trusted-rig-platform-surface";
import {
  assertTrustedRigPlatformRuntimeMatches,
  captureTrustedRigPlatformRuntimeManifest,
  type TrustedRigPlatformRuntimeManifest,
  type TrustedRigPlatformRuntimePathMetadata,
  type TrustedRigPlatformRuntimePathType,
} from "./trusted-rig-platform-runtime-integrity";
import type {
  ProviderTrustedRigPlatformRuntimeInspectionInput,
  ProviderTrustedRigPlatformSurfaceInput,
} from "./types";

const DOCKER_IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const DOCKER_NOT_FOUND = /No such (?:object|container|network):|network .* not found/iu;
const DOCKER_CONTAINER_ID = /^[0-9a-f]{12,64}$/u;
const DOCKER_API_VERSION = /^[0-9]+\.[0-9]+$/u;
const DOCKER_MODE_DIRECTORY = 0x8000_0000;
const DOCKER_MODE_SYMLINK = 0x0800_0000;
const DOCKER_MODE_TYPE = 0x8f28_0000;

type DockerRigSession = BrowserControlPlacementSession & {
  state?: { containerId?: string };
};

type DockerDaemonConnection = Readonly<{
  apiVersion: string;
  socketPath: string;
}>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function inspectionDeadlineAt(input: ProviderTrustedRigPlatformRuntimeInspectionInput): number {
  return Math.min(Date.now() + input.timeoutMs, input.deadlineAtMs ?? Number.POSITIVE_INFINITY);
}

function inspectionRemainingMs(deadlineAtMs: number): number {
  const remaining = Math.floor(deadlineAtMs - Date.now());
  if (remaining <= 0) {
    throw new Error("Docker trusted Rig runtime inspection deadline was reached");
  }
  return Math.max(1, Math.min(10 * 60_000, remaining));
}

function dockerSidecarIdentity(
  input: ProviderTrustedRigPlatformSurfaceInput,
  purpose: TrustedRigPlatformSidecarPurpose,
): {
  name: string;
  networkName: string;
  label: string;
} {
  const label = createHash("sha256")
    .update(
      [
        input.instanceId,
        input.leaseId,
        String(input.leaseEpoch),
        String(input.workspaceGeneration),
        input.rigVersionId,
        purpose,
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
  return {
    name: `opengeni-rig-${purpose}-${label.slice(0, 20)}`,
    networkName: `opengeni-rig-${purpose}-net-${label.slice(0, 16)}`,
    label,
  };
}

async function dockerCommand(input: {
  args: string[];
  stdin?: Uint8Array;
  timeoutMs: number;
  signal?: AbortSignal;
  onAbort?: () => Promise<void>;
  allowNotFound?: boolean;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  input.signal?.throwIfAborted();
  const child = spawn("docker", input.args, {
    stdio: [input.stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
  if (input.stdin && child.stdin) {
    child.stdin.end(input.stdin);
  }
  let timedOut = false;
  let aborted: unknown;
  let stopPromise: Promise<void> | null = null;
  const stop = (reason: unknown): Promise<void> => {
    if (aborted === undefined) aborted = reason;
    if (stopPromise) return stopPromise;
    child.kill("SIGKILL");
    try {
      stopPromise = input.onAbort?.().catch(() => undefined) ?? Promise.resolve();
    } catch {
      stopPromise = Promise.resolve();
    }
    return stopPromise;
  };
  const timer = setTimeout(() => {
    timedOut = true;
    void stop(new Error("Docker trusted sidecar deadline was reached"));
  }, input.timeoutMs);
  const onAbort = (): void => {
    void stop(input.signal?.reason ?? new Error("Docker trusted sidecar operation aborted"));
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? -1));
      });
    } finally {
      if (stopPromise) await stopPromise;
    }
    const output = {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode,
    };
    if (aborted !== undefined) throw aborted;
    if (timedOut) throw new Error("Docker trusted sidecar deadline was reached");
    if (
      exitCode !== 0 &&
      !(input.allowNotFound && DOCKER_NOT_FOUND.test(`${output.stdout}\n${output.stderr}`))
    ) {
      throw new Error(
        `docker ${input.args[0] ?? "command"} failed (${exitCode}): ${output.stderr || output.stdout}`,
      );
    }
    return output;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function dockerPathType(mode: number): TrustedRigPlatformRuntimePathType {
  const unsignedMode = mode >>> 0;
  if ((unsignedMode & DOCKER_MODE_DIRECTORY) !== 0) return "directory";
  if ((unsignedMode & DOCKER_MODE_SYMLINK) !== 0) return "symlink";
  if ((unsignedMode & DOCKER_MODE_TYPE) === 0) return "file";
  return "other";
}

export function dockerTrustedRigPlatformPathMetadataFromHeader(
  path: string,
  encodedHeader: string,
): TrustedRigPlatformRuntimePathMetadata {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encodedHeader, "base64").toString("utf8"));
  } catch {
    throw new Error(`Docker returned invalid trusted Rig runtime metadata for ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Docker returned invalid trusted Rig runtime metadata for ${path}`);
  }
  const stat = value as Record<string, unknown>;
  if (
    typeof stat.name !== "string" ||
    !stat.name ||
    !Number.isSafeInteger(stat.size) ||
    (stat.size as number) < 0 ||
    !Number.isSafeInteger(stat.mode) ||
    (stat.mode as number) < 0 ||
    (stat.mode as number) > 0xffff_ffff ||
    typeof stat.linkTarget !== "string"
  ) {
    throw new Error(`Docker returned invalid trusted Rig runtime metadata for ${path}`);
  }
  const mode = stat.mode as number;
  return {
    path,
    type: dockerPathType(mode),
    sizeBytes: stat.size as number,
    mode,
    symlinkTarget: stat.linkTarget ? stat.linkTarget : null,
  };
}

async function resolveDockerDaemonConnection(input: {
  deadlineAtMs: number;
  signal?: AbortSignal;
}): Promise<DockerDaemonConnection> {
  const commandInput = {
    timeoutMs: Math.min(inspectionRemainingMs(input.deadlineAtMs), 10_000),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const [context, version] = await Promise.all([
    dockerCommand({
      args: ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      ...commandInput,
    }),
    dockerCommand({
      args: ["version", "--format", "{{.Server.APIVersion}}"],
      ...commandInput,
    }),
  ]);
  let host: unknown;
  try {
    host = JSON.parse(context.stdout.trim());
  } catch {
    throw new Error("Docker trusted Rig runtime inspection resolved no daemon endpoint");
  }
  const apiVersion = version.stdout.trim();
  if (typeof host !== "string" || !DOCKER_API_VERSION.test(apiVersion)) {
    throw new Error("Docker trusted Rig runtime inspection resolved no daemon endpoint");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(host);
  } catch {
    throw new Error("Docker trusted Rig runtime inspection resolved no daemon endpoint");
  }
  if (endpoint.protocol !== "unix:" || !endpoint.pathname) {
    throw new Error(
      "Docker trusted Rig runtime inspection requires a local Unix-socket daemon endpoint",
    );
  }
  return { apiVersion, socketPath: decodeURIComponent(endpoint.pathname) };
}

async function inspectDockerContainerPath(input: {
  connection: DockerDaemonConnection;
  containerId: string;
  path: string;
  deadlineAtMs: number;
  signal?: AbortSignal;
}): Promise<TrustedRigPlatformRuntimePathMetadata> {
  input.signal?.throwIfAborted();
  if (!DOCKER_CONTAINER_ID.test(input.containerId)) {
    throw new Error("Docker trusted Rig runtime inspection requires an exact container id");
  }
  const timeoutMs = inspectionRemainingMs(input.deadlineAtMs);
  return await new Promise<TrustedRigPlatformRuntimePathMetadata>((resolve, reject) => {
    let settled = false;
    const finish = (
      result:
        | { ok: true; value: TrustedRigPlatformRuntimePathMetadata }
        | { ok: false; error: unknown },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (result.ok) resolve(result.value);
      else reject(result.error);
    };
    const request = httpRequest(
      {
        method: "HEAD",
        socketPath: input.connection.socketPath,
        path: `/v${input.connection.apiVersion}/containers/${encodeURIComponent(input.containerId)}/archive?path=${encodeURIComponent(input.path)}`,
      },
      (response) => {
        response.resume();
        if (response.statusCode !== 200) {
          finish({
            ok: false,
            error: new Error(
              `Docker trusted Rig runtime metadata request failed (${response.statusCode ?? "unknown"}) for ${input.path}`,
            ),
          });
          return;
        }
        const encoded = response.headers["x-docker-container-path-stat"];
        if (typeof encoded !== "string") {
          finish({
            ok: false,
            error: new Error(`Docker returned no trusted Rig runtime metadata for ${input.path}`),
          });
          return;
        }
        try {
          finish({
            ok: true,
            value: dockerTrustedRigPlatformPathMetadataFromHeader(input.path, encoded),
          });
        } catch (error) {
          finish({ ok: false, error });
        }
      },
    );
    const onAbort = (): void => {
      request.destroy(
        input.signal?.reason ?? new Error("Docker trusted Rig runtime inspection aborted"),
      );
    };
    const timer = setTimeout(
      () =>
        request.destroy(new Error("Docker trusted Rig runtime inspection deadline was reached")),
      timeoutMs,
    );
    request.once("error", (error) => finish({ ok: false, error }));
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

async function captureDockerTrustedRigPlatformRuntime(input: {
  settings: ProviderTrustedRigPlatformRuntimeInspectionInput["settings"];
  containerId: string;
  deadlineAtMs: number;
  signal?: AbortSignal;
}): Promise<TrustedRigPlatformRuntimeManifest> {
  const connection = await resolveDockerDaemonConnection(input);
  const directory = await mkdtemp(join(tmpdir(), "opengeni-rig-runtime-"));
  let nextFile = 0;
  try {
    return await captureTrustedRigPlatformRuntimeManifest({
      settings: input.settings,
      ...(input.signal ? { signal: input.signal } : {}),
      inspectPath: async (path) =>
        await inspectDockerContainerPath({
          connection,
          containerId: input.containerId,
          path,
          deadlineAtMs: input.deadlineAtMs,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      readBytes: async (path) => {
        const localPath = join(directory, String(nextFile++).padStart(3, "0"));
        await dockerCommand({
          args: ["cp", `${input.containerId}:${path}`, localPath],
          timeoutMs: inspectionRemainingMs(input.deadlineAtMs),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const copied = await lstat(localPath);
        if (!copied.isFile() || copied.isSymbolicLink()) {
          throw new Error(`Docker copied a non-regular trusted Rig runtime path for ${path}`);
        }
        return await readFile(localPath);
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function removeDockerSidecar(name: string, timeoutMs: number): Promise<void> {
  await dockerCommand({
    args: ["rm", "--force", name],
    timeoutMs,
    allowNotFound: true,
  });
}

async function removeDockerNetwork(name: string, timeoutMs: number): Promise<void> {
  await dockerCommand({
    args: ["network", "rm", name],
    timeoutMs,
    allowNotFound: true,
  });
}

async function removeDockerSidecarResources(
  identity: ReturnType<typeof dockerSidecarIdentity>,
  timeoutMs: number,
): Promise<void> {
  const deadlineAtMs = Date.now() + Math.max(1, timeoutMs);
  await removeDockerSidecar(
    identity.name,
    Math.max(1, Math.min(10_000, deadlineAtMs - Date.now())),
  );
  await removeDockerNetwork(
    identity.networkName,
    Math.max(1, Math.min(10_000, deadlineAtMs - Date.now())),
  );
}

async function resolveDockerSidecarPort(
  name: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onAbort: () => Promise<void>,
): Promise<ExposedPortEndpoint> {
  const published = await dockerCommand({
    args: ["port", name, `${port}/tcp`],
    timeoutMs,
    ...(signal ? { signal } : {}),
    onAbort,
  });
  const endpoints = published.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const loopback = endpoints
    .map((endpoint) => /^127\.0\.0\.1:([0-9]+)$/u.exec(endpoint))
    .find((match) => match !== null);
  const hostPort = Number(loopback?.[1]);
  if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
    throw new Error("Docker trusted Rig sidecar exposes no loopback controller port");
  }
  return {
    host: "127.0.0.1",
    port: hostPort,
    baseUrl: `http://127.0.0.1:${hostPort}`,
    hostFetchAllowed: true,
  };
}

async function createDockerSidecar(
  input: ProviderTrustedRigPlatformSurfaceInput,
  operation: TrustedRigPlatformSurfaceOperation,
  purpose: TrustedRigPlatformSidecarPurpose,
): Promise<TrustedRigPlatformSidecar> {
  const session = input.session as DockerRigSession;
  if (session.state?.containerId !== input.instanceId) {
    throw new Error("Docker trusted Rig validation requires the exact live container session");
  }
  const inspected = await dockerCommand({
    args: ["inspect", "--type", "container", "--format", "{{.Image}}", input.instanceId],
    timeoutMs: Math.min(operation.timeoutMs, 10_000),
    ...(operation.signal ? { signal: operation.signal } : {}),
  });
  const providerImageId = inspected.stdout.trim();
  if (
    !DOCKER_IMAGE_ID.test(providerImageId) ||
    (input.expectedProviderImageId !== undefined &&
      input.expectedProviderImageId !== providerImageId)
  ) {
    throw new Error("Docker trusted Rig validation resolved no immutable image id");
  }
  const runtimeAuthorityImageId = input.runtimeAuthorityImageId ?? providerImageId;
  if (!DOCKER_IMAGE_ID.test(runtimeAuthorityImageId)) {
    throw new Error("Docker trusted Rig validation resolved no immutable runtime authority image");
  }
  const initialDeadlineAtMs = Math.min(
    Date.now() + operation.timeoutMs,
    operation.deadlineAtMs ?? Number.POSITIVE_INFINITY,
  );
  const assertCandidateRuntimeIntegrity = async (options: {
    timeoutMs: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
  }): Promise<void> => {
    const deadlineAtMs = Math.min(
      Date.now() + options.timeoutMs,
      options.deadlineAtMs ?? Number.POSITIVE_INFINITY,
    );
    const liveImage = await dockerCommand({
      args: ["inspect", "--type", "container", "--format", "{{.Image}}", input.instanceId],
      timeoutMs: Math.min(inspectionRemainingMs(deadlineAtMs), 10_000),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (liveImage.stdout.trim() !== providerImageId) {
      throw new Error("Docker trusted Rig candidate changed its immutable image binding");
    }
    const actual = await captureDockerTrustedRigPlatformRuntime({
      settings: input.settings,
      containerId: input.instanceId,
      deadlineAtMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    assertTrustedRigPlatformRuntimeMatches(input.runtimeManifest, actual);
  };
  await assertCandidateRuntimeIntegrity({
    timeoutMs: inspectionRemainingMs(initialDeadlineAtMs),
    deadlineAtMs: initialDeadlineAtMs,
    ...(operation.signal ? { signal: operation.signal } : {}),
  });
  const identity = dockerSidecarIdentity(input, purpose);
  const existing = await dockerCommand({
    args: [
      "inspect",
      "--type",
      "container",
      "--format",
      '{{index .Config.Labels "io.opengeni.rig-surface"}}',
      identity.name,
    ],
    timeoutMs: Math.min(operation.timeoutMs, 5_000),
    allowNotFound: true,
  });
  if (existing.exitCode === 0) {
    if (existing.stdout.trim() !== identity.label) {
      throw new Error("Docker trusted Rig sidecar name is owned by another binding");
    }
    await removeDockerSidecar(identity.name, Math.min(operation.timeoutMs, 10_000));
  }
  const existingNetwork = await dockerCommand({
    args: [
      "network",
      "inspect",
      "--format",
      '{{index .Labels "io.opengeni.rig-surface"}}',
      identity.networkName,
    ],
    timeoutMs: Math.min(operation.timeoutMs, 5_000),
    allowNotFound: true,
  });
  if (existingNetwork.exitCode === 0) {
    if (existingNetwork.stdout.trim() !== identity.label) {
      throw new Error("Docker trusted Rig sidecar network is owned by another binding");
    }
    await removeDockerNetwork(identity.networkName, Math.min(operation.timeoutMs, 10_000));
  }
  await dockerCommand({
    args: [
      "network",
      "create",
      "--internal",
      "--label",
      `io.opengeni.rig-surface=${identity.label}`,
      identity.networkName,
    ],
    timeoutMs: operation.timeoutMs,
    ...(operation.signal ? { signal: operation.signal } : {}),
    onAbort: async () =>
      await removeDockerSidecarResources(identity, Math.min(operation.timeoutMs, 15_000)),
  });
  let terminated = false;
  const terminate = async (): Promise<void> => {
    if (terminated) return;
    terminated = true;
    await removeDockerSidecarResources(identity, 15_000);
  };
  let created: Awaited<ReturnType<typeof dockerCommand>>;
  try {
    created = await dockerCommand({
      args: [
        "run",
        "--detach",
        "--rm",
        "--name",
        identity.name,
        "--label",
        `io.opengeni.rig-surface=${identity.label}`,
        "--network",
        identity.networkName,
        "--publish",
        "127.0.0.1::7682",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,exec,size=1073741824",
        "--tmpfs",
        "/run:rw,nosuid,nodev,exec,size=67108864",
        "--user",
        "0:0",
        "--workdir",
        "/workspace",
        "--entrypoint",
        "/bin/sh",
        runtimeAuthorityImageId,
        "-c",
        "exec /usr/bin/sleep infinity",
      ],
      timeoutMs: operation.timeoutMs,
      ...(operation.signal ? { signal: operation.signal } : {}),
      onAbort: terminate,
    });
  } catch (error) {
    await removeDockerSidecarResources(identity, 15_000).catch(() => undefined);
    throw error;
  }
  const sidecarId = created.stdout.trim();
  if (!DOCKER_CONTAINER_ID.test(sidecarId)) {
    await terminate().catch(() => undefined);
    throw new Error("Docker trusted Rig sidecar returned no container identity");
  }
  try {
    const actualRuntimeManifest = await captureDockerTrustedRigPlatformRuntime({
      settings: input.settings,
      containerId: sidecarId,
      deadlineAtMs: Math.min(
        Date.now() + operation.timeoutMs,
        operation.deadlineAtMs ?? Number.POSITIVE_INFINITY,
      ),
      ...(operation.signal ? { signal: operation.signal } : {}),
    });
    assertTrustedRigPlatformRuntimeMatches(input.runtimeManifest, actualRuntimeManifest);
  } catch (error) {
    await terminate().catch(() => undefined);
    throw error;
  }

  const assertRuntimeIntegrity: TrustedRigPlatformSidecar["assertRuntimeIntegrity"] = async (
    options,
  ) => {
    if (terminated) throw new Error("Docker trusted Rig sidecar is terminated");
    await assertCandidateRuntimeIntegrity(options);
    const deadlineAtMs = Math.min(
      Date.now() + options.timeoutMs,
      options.deadlineAtMs ?? Number.POSITIVE_INFINITY,
    );
    const authority = await captureDockerTrustedRigPlatformRuntime({
      settings: input.settings,
      containerId: sidecarId,
      deadlineAtMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    assertTrustedRigPlatformRuntimeMatches(input.runtimeManifest, authority);
  };

  const execute = async (
    args: Parameters<NonNullable<BrowserControlPlacementSession["exec"]>>[0],
  ) => {
    if (terminated) throw new Error("Docker trusted Rig sidecar is terminated");
    const timeoutMs = Math.max(
      1,
      Math.min(
        args.timeoutMs ?? args.yieldTimeMs ?? operation.timeoutMs,
        (args.deadlineAtMs ?? Number.POSITIVE_INFINITY) - Date.now(),
      ),
    );
    const result = await dockerCommand({
      args: [
        "exec",
        ...(args.tty ? ["--tty"] : []),
        "--workdir",
        args.workdir ?? "/workspace",
        identity.name,
        "/bin/sh",
        "-c",
        args.cmd,
      ],
      timeoutMs,
      ...(args.signal ? { signal: args.signal } : {}),
      onAbort: terminate,
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  const writePlacementPrivate: NonNullable<
    BrowserControlPlacementSession["writePlacementPrivate"]
  > = async (args) => {
    if (terminated) throw new Error("Docker trusted Rig sidecar is terminated");
    const timeoutMs = Math.max(
      1,
      Math.min(
        args.timeoutMs ?? operation.timeoutMs,
        (args.deadlineAtMs ?? Number.POSITIVE_INFINITY) - Date.now(),
      ),
    );
    const parent = args.path.slice(0, args.path.lastIndexOf("/")) || "/";
    const content = typeof args.content === "string" ? Buffer.from(args.content) : args.content;
    await dockerCommand({
      args: [
        "exec",
        "--interactive",
        identity.name,
        "/bin/sh",
        "-c",
        `umask 077; /usr/bin/install -d -m 0700 -- ${shellQuote(parent)}; /usr/bin/cat > ${shellQuote(args.path)}; /usr/bin/chmod 0600 -- ${shellQuote(args.path)}`,
      ],
      stdin: content,
      timeoutMs,
      ...(args.signal ? { signal: args.signal } : {}),
      onAbort: terminate,
    });
    return content.byteLength;
  };

  return {
    sidecarId,
    assertRuntimeIntegrity,
    exec: execute,
    writePlacementPrivate,
    writeFile: writePlacementPrivate,
    resolveExposedPort: async (port, options) => {
      options?.signal?.throwIfAborted();
      const timeoutMs = Math.max(
        1,
        Math.min(
          options?.timeoutMs ?? operation.timeoutMs,
          (options?.deadlineAtMs ?? Number.POSITIVE_INFINITY) - Date.now(),
        ),
      );
      const endpoint = await resolveDockerSidecarPort(
        identity.name,
        port,
        timeoutMs,
        options?.signal,
        terminate,
      );
      options?.signal?.throwIfAborted();
      return endpoint;
    },
    finalizeOpStreamOps: async () => undefined,
    terminate: async () => await terminate(),
  };
}

export async function inspectDockerTrustedRigPlatformRuntime(
  input: ProviderTrustedRigPlatformRuntimeInspectionInput,
) {
  const session = input.session as DockerRigSession;
  if (session.state?.containerId !== input.instanceId) {
    throw new Error("Docker trusted Rig runtime inspection requires the exact live container");
  }
  const deadlineAtMs = inspectionDeadlineAt(input);
  const inspected = await dockerCommand({
    args: ["inspect", "--type", "container", "--format", "{{.Image}}", input.instanceId],
    timeoutMs: Math.min(inspectionRemainingMs(deadlineAtMs), 10_000),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const providerImageId = inspected.stdout.trim();
  if (
    !DOCKER_IMAGE_ID.test(providerImageId) ||
    (input.expectedProviderImageId !== undefined &&
      input.expectedProviderImageId !== providerImageId)
  ) {
    throw new Error("Docker trusted Rig runtime inspection resolved another immutable image id");
  }

  return await captureDockerTrustedRigPlatformRuntime({
    settings: input.settings,
    containerId: input.instanceId,
    deadlineAtMs,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function createDockerTrustedRigPlatformSurface(
  input: ProviderTrustedRigPlatformSurfaceInput,
): Promise<TrustedRigPlatformSurface> {
  const inspected = await dockerCommand({
    args: ["inspect", "--type", "container", "--format", "{{.Image}}", input.instanceId],
    timeoutMs: 10_000,
  });
  const providerImageId = inspected.stdout.trim();
  if (!DOCKER_IMAGE_ID.test(providerImageId)) {
    throw new Error("Docker trusted Rig validation requires an immutable image id");
  }
  if (
    input.expectedProviderImageId !== undefined &&
    input.expectedProviderImageId !== providerImageId
  ) {
    throw new Error("Docker trusted Rig validation resolved another immutable image id");
  }
  const runtimeAuthorityImageId = input.runtimeAuthorityImageId ?? providerImageId;
  if (!DOCKER_IMAGE_ID.test(runtimeAuthorityImageId)) {
    throw new Error("Docker trusted Rig validation requires an immutable runtime authority image");
  }
  return createTrustedRigPlatformSurface({
    binding: {
      authority: "deployment_control_plane",
      backendId: "docker",
      instanceId: input.instanceId,
      providerImage: input.providerImage,
      providerImageId,
      runtimeAuthorityImageId,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      workspaceGeneration: input.workspaceGeneration,
      sandboxGroupId: input.sandboxGroupId,
      rigVersionId: input.rigVersionId,
      runtimeManifestDigest: input.runtimeManifest.digest,
    },
    desktopEnabled: input.settings.sandboxDesktopEnabled,
    createSidecar: async (operation, purpose) =>
      await createDockerSidecar(input, operation, purpose),
  });
}
