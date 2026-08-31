import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExposedPortEndpoint } from "@openai/agents/sandbox";
import type {
  BrowserControlPlacementSession,
  TrustedRigPlatformSurface,
  TrustedRigPlatformSurfaceOperation,
} from "../browser-control-client";
import {
  createTrustedRigPlatformSurface,
  type TrustedRigPlatformSidecar,
} from "./trusted-rig-platform-surface";
import type { ProviderTrustedRigPlatformSurfaceInput } from "./types";

const DOCKER_IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const DOCKER_NOT_FOUND = /No such (?:object|container|network):|network .* not found/iu;

type DockerRigSession = BrowserControlPlacementSession & {
  state?: { containerId?: string };
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function dockerSidecarIdentity(input: ProviderTrustedRigPlatformSurfaceInput): {
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
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
  return {
    name: `opengeni-rig-surface-${label.slice(0, 24)}`,
    networkName: `opengeni-rig-surface-net-${label.slice(0, 20)}`,
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
  const identity = dockerSidecarIdentity(input);
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
        "--user",
        "0:0",
        "--workdir",
        "/workspace",
        providerImageId,
        "/bin/sh",
        "-lc",
        "exec sleep infinity",
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
  if (!/^[0-9a-f]{12,64}$/u.test(sidecarId)) {
    await terminate().catch(() => undefined);
    throw new Error("Docker trusted Rig sidecar returned no container identity");
  }

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
        "-lc",
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
        "-lc",
        `umask 077; install -d -m 0700 -- ${shellQuote(parent)}; cat > ${shellQuote(args.path)}; chmod 0600 -- ${shellQuote(args.path)}`,
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
  return createTrustedRigPlatformSurface({
    binding: {
      authority: "deployment_control_plane",
      backendId: "docker",
      instanceId: input.instanceId,
      providerImage: input.providerImage,
      providerImageId,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      workspaceGeneration: input.workspaceGeneration,
      sandboxGroupId: input.sandboxGroupId,
      rigVersionId: input.rigVersionId,
    },
    desktopEnabled: input.settings.sandboxDesktopEnabled,
    createSidecar: async (operation) => await createDockerSidecar(input, operation),
  });
}
