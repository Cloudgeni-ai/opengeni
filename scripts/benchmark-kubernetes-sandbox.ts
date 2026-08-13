import {
  getSettings,
  parseKubernetesNodeSelectorJson,
  parseKubernetesTolerationsJson,
} from "@opengeni/config";
import {
  Manifest,
  file,
  type SandboxClient,
  type SandboxSessionLike,
} from "@openai/agents/sandbox";
import { createSandboxClient, type KubernetesSandboxSessionState } from "@opengeni/runtime/sandbox";

const settings = getSettings();
if (settings.sandboxBackend !== "kubernetes") {
  throw new Error("Set OPENGENI_SANDBOX_BACKEND=kubernetes before running this benchmark");
}

const client = createSandboxClient(settings) as SandboxClient<
  Record<string, unknown>,
  KubernetesSandboxSessionState
>;
const manifest = new Manifest({
  root: "/workspace",
  entries: {
    "benchmark/input.txt": file({
      content: "OpenGeni Kubernetes sandbox benchmark\n",
    }),
  },
});

let session: SandboxSessionLike<KubernetesSandboxSessionState> | null = null;
const startedAt = performance.now();
try {
  session = await client.create!({ manifest });
  const readyAt = performance.now();
  const commandStartedAt = performance.now();
  const command = await session.execCommand!({
    cmd: [
      "cat benchmark/input.txt",
      "printf '\\n--- cgroup ---\\n'",
      "cat /sys/fs/cgroup/memory.current 2>/dev/null || true",
      "cat /sys/fs/cgroup/cpu.stat 2>/dev/null || true",
    ].join(" && "),
    workdir: "/workspace",
    maxOutputTokens: 4_000,
  });
  const commandFinishedAt = performance.now();
  const archiveStartedAt = performance.now();
  const archive = await session.persistWorkspace!();
  const archiveFinishedAt = performance.now();
  const serialized = await client.serializeSessionState!(session.state);
  await session.close?.();
  const deserialized = await client.deserializeSessionState!(serialized);
  const resumeStartedAt = performance.now();
  session = await (
    client as SandboxClient & {
      resumeExact(
        state: KubernetesSandboxSessionState,
      ): Promise<SandboxSessionLike<KubernetesSandboxSessionState>>;
    }
  ).resumeExact(deserialized);
  const resumeFinishedAt = performance.now();

  console.log(
    JSON.stringify(
      {
        backend: "kubernetes",
        namespace: session.state.namespace,
        podName: session.state.podName,
        podUid: session.state.podUid,
        image: session.state.image,
        isolation: {
          mode: settings.kubernetesIsolationMode,
          runtimeClass: settings.kubernetesRuntimeClass ?? null,
          nodeSelector: parseKubernetesNodeSelectorJson(settings.kubernetesNodeSelectorJson),
          tolerations: parseKubernetesTolerationsJson(settings.kubernetesTolerationsJson),
        },
        configuredResources: {
          cpuRequest: settings.kubernetesCpuRequest,
          cpuLimit: settings.kubernetesCpuLimit,
          memoryRequest: settings.kubernetesMemoryRequest,
          memoryLimit: settings.kubernetesMemoryLimit,
          ephemeralStorageRequest: settings.kubernetesEphemeralStorageRequest,
          ephemeralStorageLimit: settings.kubernetesEphemeralStorageLimit,
          workspaceSizeLimit: settings.kubernetesWorkspaceSizeLimit,
        },
        timingsMs: {
          createToReady: Math.round((readyAt - startedAt) * 100) / 100,
          commandRoundTrip: Math.round((commandFinishedAt - commandStartedAt) * 100) / 100,
          workspaceCapture: Math.round((archiveFinishedAt - archiveStartedAt) * 100) / 100,
          exactResume: Math.round((resumeFinishedAt - resumeStartedAt) * 100) / 100,
        },
        archiveBytes: archive.byteLength,
        command,
      },
      null,
      2,
    ),
  );
} finally {
  await session?.delete?.().catch(() => undefined);
}
