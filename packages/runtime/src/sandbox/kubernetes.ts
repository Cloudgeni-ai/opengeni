import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  Manifest,
  SandboxProviderError,
  type SandboxArchiveLimits,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxConcurrencyLimits,
  type SandboxSessionLifecycleOptions,
  type SandboxSessionState,
  normalizeSandboxClientCreateArgs,
} from "@openai/agents-core/sandbox";
import {
  RemoteSandboxSessionBase,
  SANDBOX_MANIFEST_METADATA_SUPPORT,
  assertCoreSnapshotUnsupported,
  assertRemoteSandboxSessionStateCanResume,
  assertSandboxManifestMetadataSupported,
  closeRemoteSessionOnManifestError,
  materializeEnvironment,
  readOptionalBoolean,
  readOptionalString,
  readString,
  rehydrateRemoteSandboxSessionStateValues,
  serializeRemoteSandboxSessionState,
  shellQuote,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
} from "@openai/agents-extensions/sandbox/shared";

const KUBERNETES_CONTAINER_NAME = "sandbox";
const KUBERNETES_COMMAND_MAX_BYTES = 64 * 1024 * 1024;
const KUBERNETES_FILE_MAX_BYTES = 256 * 1024 * 1024;

export interface KubernetesSandboxClientOptions extends SandboxClientOptions {
  image?: string;
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  kubectlPath?: string;
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  runtimeClassName?: string;
  priorityClassName?: string;
  nodeSelector?: Record<string, string>;
  tolerations?: Array<{
    key?: string | undefined;
    operator?: "Exists" | "Equal" | undefined;
    value?: string | undefined;
    effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute" | undefined;
    tolerationSeconds?: number | undefined;
  }>;
  startupTimeoutSeconds?: number;
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
  ephemeralStorageRequest?: string;
  ephemeralStorageLimit?: string;
  workspaceSizeLimit?: string;
  env?: Record<string, string>;
  workspacePersistence?: true | "tar";
}

export interface KubernetesSandboxSessionState extends SandboxSessionState {
  podName: string;
  podUid: string;
  namespace: string;
  containerName: string;
  image: string;
  kubeconfig?: string;
  context?: string;
  kubectlPath: string;
  workspacePersistence: true | "tar";
  environment: Record<string, string>;
}

type KubectlResult = {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
};

type KubernetesPod = {
  metadata?: { name?: unknown; namespace?: unknown; uid?: unknown };
  status?: {
    phase?: unknown;
    conditions?: Array<{ type?: unknown; status?: unknown }>;
  };
};

function commandErrorMessage(result: KubectlResult): string {
  return [result.stderr.toString("utf8").trim(), result.stdout.toString("utf8").trim()]
    .filter(Boolean)
    .join("\n");
}

function kubectlNotFound(result: KubectlResult): boolean {
  return /\bNotFound\b|\bnot found\b/iu.test(commandErrorMessage(result));
}

function providerError(message: string, details: Record<string, unknown>): SandboxProviderError {
  return new SandboxProviderError(message, {
    provider: "kubernetes",
    ...details,
  });
}

function notFoundError(podName: string, namespace: string): SandboxProviderError {
  const error = providerError(`Kubernetes sandbox Pod ${namespace}/${podName} was not found.`, {
    podName,
    namespace,
  });
  (error as unknown as { code: string }).code = "SANDBOX_NOT_FOUND";
  return error;
}

async function runProcess(input: {
  command: string;
  args: string[];
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<KubectlResult> {
  return await new Promise<KubectlResult>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maxBytes = input.maxBytes ?? KUBERNETES_COMMAND_MAX_BYTES;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > maxBytes) {
        fail(new Error(`kubectl output exceeded ${maxBytes} bytes`));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > maxBytes) {
        fail(new Error(`kubectl output exceeded ${maxBytes} bytes`));
        return;
      }
      stderr.push(Buffer.from(chunk));
    });
    child.once("error", fail);
    child.stdin!.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({
        status: typeof code === "number" ? code : 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (input.stdin !== undefined) {
      child.stdin!.end(input.stdin);
    } else {
      child.stdin!.end();
    }
    if (input.timeoutMs !== undefined) {
      const timer = setTimeout(
        () => fail(new Error(`kubectl timed out after ${input.timeoutMs}ms`)),
        input.timeoutMs,
      );
      timer.unref?.();
      child.once("close", () => clearTimeout(timer));
      child.once("error", () => clearTimeout(timer));
    }
  });
}

function kubectlBaseArgs(
  state: Pick<KubernetesSandboxSessionState, "kubeconfig" | "context" | "namespace">,
): string[] {
  return [
    ...(state.kubeconfig ? ["--kubeconfig", state.kubeconfig] : []),
    ...(state.context ? ["--context", state.context] : []),
    "--namespace",
    state.namespace,
  ];
}

function podIsReady(pod: KubernetesPod): boolean {
  return (
    pod.status?.phase === "Running" &&
    pod.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) === true
  );
}

function parsePod(result: KubectlResult, operation: string): KubernetesPod {
  if (result.status !== 0) {
    throw providerError(`Kubernetes sandbox failed to ${operation}.`, {
      operation,
      cause: commandErrorMessage(result),
    });
  }
  try {
    return JSON.parse(result.stdout.toString("utf8")) as KubernetesPod;
  } catch (error) {
    throw providerError(
      `Kubernetes sandbox returned invalid Pod JSON while attempting to ${operation}.`,
      {
        operation,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export class KubernetesSandboxSession extends RemoteSandboxSessionBase<KubernetesSandboxSessionState> {
  constructor(args: {
    state: KubernetesSandboxSessionState;
    concurrencyLimits?: SandboxConcurrencyLimits;
    archiveLimits?: SandboxArchiveLimits | null;
  }) {
    super({
      state: args.state,
      options: {
        providerName: "KubernetesSandboxClient",
        providerId: "kubernetes",
        ...(args.concurrencyLimits ? { concurrencyLimits: args.concurrencyLimits } : {}),
        ...(args.archiveLimits !== undefined ? { archiveLimits: args.archiveLimits } : {}),
      },
    });
  }

  protected manifestMetadataSupport() {
    return SANDBOX_MANIFEST_METADATA_SUPPORT;
  }

  protected async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    const remoteCommand = [`cd -- ${shellQuote(options.workdir)}`, command].join(" && ");
    const result = await this.kubectlExec(
      ["/bin/sh", "-lc", remoteCommand],
      undefined,
      options.timeoutMs,
    );
    return {
      status: result.status,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  }

  protected async mkdirRemote(path: string): Promise<void> {
    await this.checkedExec(["mkdir", "-p", "--", path], `create directory ${path}`);
  }

  protected async readRemoteText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readRemoteFile(path));
  }

  protected async readRemoteFile(path: string): Promise<Uint8Array> {
    const result = await this.kubectlExec(
      ["cat", "--", path],
      undefined,
      undefined,
      KUBERNETES_FILE_MAX_BYTES,
    );
    if (result.status !== 0) {
      throw providerError(`Kubernetes sandbox failed to read ${path}.`, {
        podName: this.state.podName,
        namespace: this.state.namespace,
        path,
        cause: commandErrorMessage(result),
      });
    }
    return Uint8Array.from(result.stdout);
  }

  protected async writeRemoteFile(path: string, content: string | Uint8Array): Promise<void> {
    const result = await this.kubectlExec(
      ["/bin/sh", "-c", `cat > ${shellQuote(path)}`],
      typeof content === "string" ? content : Uint8Array.from(content),
      undefined,
      KUBERNETES_FILE_MAX_BYTES,
    );
    if (result.status !== 0) {
      throw providerError(`Kubernetes sandbox failed to write ${path}.`, {
        podName: this.state.podName,
        namespace: this.state.namespace,
        path,
        cause: commandErrorMessage(result),
      });
    }
  }

  protected async deleteRemotePath(path: string): Promise<void> {
    await this.checkedExec(["rm", "-rf", "--", path], `delete ${path}`);
  }

  async close(): Promise<void> {
    // Closing an SDK handle is a detach. The durable OpenGeni lease/reaper owns
    // physical Pod deletion after workspace capture.
    if (this.state.workspaceReady !== true) await this.delete();
  }

  async shutdown(_options?: SandboxSessionLifecycleOptions): Promise<void> {
    // Same as close: exact physical teardown is delete(), after archive publish.
  }

  async delete(_options?: SandboxSessionLifecycleOptions): Promise<void> {
    await deleteKubernetesPod(this.state);
  }

  async prepareWorkspaceRoot(): Promise<void> {
    await this.mkdirRemote(this.state.manifest.root);
  }

  private async checkedExec(args: string[], operation: string): Promise<void> {
    const result = await this.kubectlExec(args);
    if (result.status !== 0) {
      throw providerError(`Kubernetes sandbox failed to ${operation}.`, {
        podName: this.state.podName,
        namespace: this.state.namespace,
        operation,
        cause: commandErrorMessage(result),
      });
    }
  }

  private async kubectlExec(
    remoteArgs: string[],
    stdin?: string | Uint8Array,
    timeoutMs?: number,
    maxBytes?: number,
  ): Promise<KubectlResult> {
    const result = await runProcess({
      command: this.state.kubectlPath,
      args: [
        ...kubectlBaseArgs(this.state),
        "exec",
        ...(stdin === undefined ? [] : ["-i"]),
        this.state.podName,
        "--container",
        this.state.containerName,
        "--",
        ...remoteArgs,
      ],
      ...(stdin === undefined ? {} : { stdin }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    if (kubectlNotFound(result)) throw notFoundError(this.state.podName, this.state.namespace);
    return result;
  }
}

export class KubernetesSandboxClient implements SandboxClient<
  KubernetesSandboxClientOptions,
  KubernetesSandboxSessionState
> {
  readonly backendId = "kubernetes";

  constructor(readonly options: KubernetesSandboxClientOptions = {}) {}

  async create(
    args?: SandboxClientCreateArgs<KubernetesSandboxClientOptions> | Manifest,
    manifestOptions?: KubernetesSandboxClientOptions,
  ): Promise<KubernetesSandboxSession> {
    return await this.createSession(args, manifestOptions);
  }

  /** OpenGeni creation seam: persist the immutable Pod UID before readiness or
   * manifest work, so a worker death cannot turn an accepted Pod into an
   * unattributed provider resource. */
  async createWithEarlyIdentity(
    args: SandboxClientCreateArgs<KubernetesSandboxClientOptions> | Manifest | undefined,
    onCreated: (session: KubernetesSandboxSession) => Promise<void>,
  ): Promise<KubernetesSandboxSession> {
    return await this.createSession(args, undefined, onCreated);
  }

  private async createSession(
    args?: SandboxClientCreateArgs<KubernetesSandboxClientOptions> | Manifest,
    manifestOptions?: KubernetesSandboxClientOptions,
    onCreated?: (session: KubernetesSandboxSession) => Promise<void>,
  ): Promise<KubernetesSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    assertCoreSnapshotUnsupported("KubernetesSandboxClient", createArgs.snapshot);
    const resolved = { ...this.options, ...createArgs.options };
    const image = resolved.image?.trim();
    if (!image) {
      throw providerError("Kubernetes sandbox image is required.", {
        operation: "create",
      });
    }
    const namespace = resolved.namespace?.trim() || (await currentKubernetesNamespace());
    const stateBase: Pick<
      KubernetesSandboxSessionState,
      "kubeconfig" | "context" | "namespace" | "kubectlPath"
    > = {
      namespace,
      kubectlPath: resolved.kubectlPath?.trim() || "kubectl",
      ...(resolved.kubeconfig ? { kubeconfig: resolved.kubeconfig } : {}),
      ...(resolved.context ? { context: resolved.context } : {}),
    };
    const manifest = createArgs.manifest;
    assertSandboxManifestMetadataSupported(
      "KubernetesSandboxClient",
      manifest,
      SANDBOX_MANIFEST_METADATA_SUPPORT,
    );
    const environment = await materializeEnvironment(manifest, resolved.env);
    const podName = `opengeni-sandbox-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const podManifest = kubernetesPodManifest({
      podName,
      namespace,
      image,
      imagePullPolicy: resolved.imagePullPolicy ?? "IfNotPresent",
      ...(resolved.serviceAccountName ? { serviceAccountName: resolved.serviceAccountName } : {}),
      automountServiceAccountToken: resolved.automountServiceAccountToken ?? false,
      ...(resolved.runtimeClassName ? { runtimeClassName: resolved.runtimeClassName } : {}),
      ...(resolved.priorityClassName ? { priorityClassName: resolved.priorityClassName } : {}),
      nodeSelector: resolved.nodeSelector ?? {},
      tolerations: resolved.tolerations ?? [],
      cpuRequest: resolved.cpuRequest ?? "250m",
      cpuLimit: resolved.cpuLimit ?? "2",
      memoryRequest: resolved.memoryRequest ?? "512Mi",
      memoryLimit: resolved.memoryLimit ?? "4Gi",
      ephemeralStorageRequest: resolved.ephemeralStorageRequest ?? "1Gi",
      ephemeralStorageLimit: resolved.ephemeralStorageLimit ?? "20Gi",
      workspaceSizeLimit: resolved.workspaceSizeLimit ?? "10Gi",
      environment,
    });
    const createResult = await runProcess({
      command: stateBase.kubectlPath,
      args: [...kubectlBaseArgs(stateBase), "create", "-f", "-", "-o", "json"],
      stdin: JSON.stringify(podManifest),
      timeoutMs: Math.max(1, resolved.startupTimeoutSeconds ?? 120) * 1_000,
    });
    const pod = parsePod(createResult, "create Pod");
    const podUid = typeof pod.metadata?.uid === "string" ? pod.metadata.uid : null;
    if (!podUid) {
      throw providerError("Kubernetes sandbox Pod creation returned no UID.", {
        podName,
        namespace,
      });
    }
    const state: KubernetesSandboxSessionState = {
      manifest,
      podName,
      podUid,
      namespace,
      containerName: KUBERNETES_CONTAINER_NAME,
      image,
      ...(resolved.kubeconfig ? { kubeconfig: resolved.kubeconfig } : {}),
      ...(resolved.context ? { context: resolved.context } : {}),
      kubectlPath: stateBase.kubectlPath,
      workspacePersistence: resolved.workspacePersistence ?? "tar",
      environment,
    };
    const session = new KubernetesSandboxSession({
      state,
      ...(createArgs.concurrencyLimits ? { concurrencyLimits: createArgs.concurrencyLimits } : {}),
      ...(createArgs.archiveLimits !== undefined
        ? { archiveLimits: createArgs.archiveLimits }
        : {}),
    });
    try {
      await onCreated?.(session);
      const wait = await runProcess({
        command: state.kubectlPath,
        args: [
          ...kubectlBaseArgs(state),
          "wait",
          "--for=condition=Ready",
          `pod/${podName}`,
          `--timeout=${Math.max(1, resolved.startupTimeoutSeconds ?? 120)}s`,
        ],
        timeoutMs: (Math.max(1, resolved.startupTimeoutSeconds ?? 120) + 5) * 1_000,
      });
      if (wait.status !== 0) {
        throw providerError(
          `Kubernetes sandbox Pod ${namespace}/${podName} did not become ready.`,
          {
            podName,
            podUid,
            namespace,
            cause: commandErrorMessage(wait),
          },
        );
      }
      await session.prepareWorkspaceRoot();
      await session.applyManifest(manifest);
      state.workspaceReady = true;
      return session;
    } catch (error) {
      await closeRemoteSessionOnManifestError("Kubernetes", session, error);
      throw error;
    }
  }

  async serializeSessionState(
    state: KubernetesSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    return serializeRemoteSandboxSessionState(state);
  }

  canPersistOwnedSessionState(_state: KubernetesSandboxSessionState): boolean {
    return true;
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<KubernetesSandboxSessionState> {
    const base = await rehydrateRemoteSandboxSessionStateValues(state, this.options.env);
    return {
      ...state,
      ...base,
      podName: readString(state, "podName"),
      podUid: readString(state, "podUid"),
      namespace: readString(state, "namespace"),
      containerName: readOptionalString(state, "containerName") ?? KUBERNETES_CONTAINER_NAME,
      image: readString(state, "image"),
      ...(readOptionalString(state, "kubeconfig")
        ? { kubeconfig: readOptionalString(state, "kubeconfig")! }
        : {}),
      ...(readOptionalString(state, "context")
        ? { context: readOptionalString(state, "context")! }
        : {}),
      kubectlPath:
        readOptionalString(state, "kubectlPath") ?? this.options.kubectlPath ?? "kubectl",
      workspacePersistence: readOptionalBoolean(state, "workspacePersistence") ? true : "tar",
      environment: base.environment,
    };
  }

  async resume(state: KubernetesSandboxSessionState): Promise<KubernetesSandboxSession> {
    assertRemoteSandboxSessionStateCanResume(state);
    const pod = await getKubernetesPod(state);
    if (pod.metadata?.uid !== state.podUid || !podIsReady(pod)) {
      throw notFoundError(state.podName, state.namespace);
    }
    return new KubernetesSandboxSession({ state });
  }

  async resumeExact(state: KubernetesSandboxSessionState): Promise<KubernetesSandboxSession> {
    return await this.resume(state);
  }

  async delete(state: KubernetesSandboxSessionState): Promise<void> {
    await deleteKubernetesPod(state);
  }
}

async function getKubernetesPod(state: KubernetesSandboxSessionState): Promise<KubernetesPod> {
  const result = await runProcess({
    command: state.kubectlPath,
    args: [...kubectlBaseArgs(state), "get", "pod", state.podName, "-o", "json"],
    timeoutMs: 15_000,
  });
  if (kubectlNotFound(result)) throw notFoundError(state.podName, state.namespace);
  return parsePod(result, "get Pod");
}

async function deleteKubernetesPod(state: KubernetesSandboxSessionState): Promise<void> {
  const pod = await getKubernetesPod(state).catch((error) => {
    if ((error as { code?: unknown })?.code === "SANDBOX_NOT_FOUND") return null;
    throw error;
  });
  if (!pod) return;
  if (pod.metadata?.uid !== state.podUid) throw notFoundError(state.podName, state.namespace);
  const result = await runProcess({
    command: state.kubectlPath,
    args: [
      ...kubectlBaseArgs(state),
      "delete",
      "pod",
      state.podName,
      "--wait=false",
      "--ignore-not-found=true",
    ],
    timeoutMs: 15_000,
  });
  if (result.status !== 0 && !kubectlNotFound(result)) {
    throw providerError(
      `Kubernetes sandbox failed to delete Pod ${state.namespace}/${state.podName}.`,
      {
        podName: state.podName,
        podUid: state.podUid,
        namespace: state.namespace,
        cause: commandErrorMessage(result),
      },
    );
  }
}

async function currentKubernetesNamespace(): Promise<string> {
  try {
    const namespace = (
      await readFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8")
    ).trim();
    if (namespace) return namespace;
  } catch {
    // Out-of-cluster clients use kubeconfig's current namespace or "default".
  }
  return "default";
}

function kubernetesPodManifest(input: {
  podName: string;
  namespace: string;
  image: string;
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  serviceAccountName?: string;
  automountServiceAccountToken: boolean;
  runtimeClassName?: string;
  priorityClassName?: string;
  nodeSelector: Record<string, string>;
  tolerations: Array<{
    key?: string | undefined;
    operator?: "Exists" | "Equal" | undefined;
    value?: string | undefined;
    effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute" | undefined;
    tolerationSeconds?: number | undefined;
  }>;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  ephemeralStorageRequest: string;
  ephemeralStorageLimit: string;
  workspaceSizeLimit: string;
  environment: Record<string, string>;
}): Record<string, unknown> {
  const labels: Record<string, string> = {
    "app.kubernetes.io/name": "opengeni-sandbox",
    "app.kubernetes.io/part-of": "opengeni",
    "opengeni.ai/managed": "true",
  };
  const labelEnv = {
    "opengeni.ai/lease-id": input.environment.OPENGENI_SANDBOX_LEASE_ID,
    "opengeni.ai/sandbox-group-id": input.environment.OPENGENI_SANDBOX_GROUP_ID,
    "opengeni.ai/workspace-id": input.environment.OPENGENI_WORKSPACE_ID,
  };
  for (const [key, value] of Object.entries(labelEnv)) {
    if (value && value.length <= 63) labels[key] = value;
  }
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: input.podName, namespace: input.namespace, labels },
    spec: {
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 10,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      enableServiceLinks: false,
      automountServiceAccountToken: input.automountServiceAccountToken,
      ...(input.serviceAccountName ? { serviceAccountName: input.serviceAccountName } : {}),
      ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
      ...(input.priorityClassName ? { priorityClassName: input.priorityClassName } : {}),
      ...(Object.keys(input.nodeSelector).length > 0 ? { nodeSelector: input.nodeSelector } : {}),
      ...(input.tolerations.length > 0 ? { tolerations: input.tolerations } : {}),
      securityContext: {
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [
        {
          name: "workspace",
          emptyDir: { sizeLimit: input.workspaceSizeLimit },
        },
      ],
      containers: [
        {
          name: KUBERNETES_CONTAINER_NAME,
          image: input.image,
          imagePullPolicy: input.imagePullPolicy,
          command: [
            "/bin/sh",
            "-lc",
            "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
          ],
          env: Object.entries(input.environment).map(([name, value]) => ({
            name,
            value,
          })),
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            capabilities: {
              drop: ["ALL"],
              add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
            },
          },
          volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
          resources: {
            requests: {
              cpu: input.cpuRequest,
              memory: input.memoryRequest,
              "ephemeral-storage": input.ephemeralStorageRequest,
            },
            limits: {
              cpu: input.cpuLimit,
              memory: input.memoryLimit,
              "ephemeral-storage": input.ephemeralStorageLimit,
            },
          },
        },
      ],
    },
  };
}
