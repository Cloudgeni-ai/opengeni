import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manifest } from "@openai/agents-core/sandbox";
import { KubernetesSandboxClient } from "../src/sandbox/kubernetes";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Kubernetes sandbox provider", () => {
  test("creates a resource-bounded Pod and resumes only its exact UID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeni-kubernetes-sandbox-"));
    temporaryDirectories.push(directory);
    const logPath = join(directory, "kubectl.jsonl");
    const kubectlPath = join(directory, "kubectl");
    await Bun.write(
      kubectlPath,
      `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
const commands = new Set(["create", "wait", "exec", "get", "delete"]);
const command = args.find((arg) => commands.has(arg));
const stdin = command === "create" ? await Bun.stdin.text() : "";
await appendFile(${JSON.stringify(logPath)}, JSON.stringify({ command, args, stdin }) + "\\n");
if (command === "create" || command === "get") {
  process.stdout.write(JSON.stringify({
    metadata: { name: "opengeni-sandbox-test", namespace: "sandboxes", uid: "pod-uid-1" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  }));
}
process.exit(0);
`,
    );
    await chmod(kubectlPath, 0o755);

    const client = new KubernetesSandboxClient({
      image: "registry.example/opengeni-sandbox@sha256:test",
      namespace: "sandboxes",
      kubectlPath,
      cpuRequest: "500m",
      cpuLimit: "2",
      memoryRequest: "1Gi",
      memoryLimit: "4Gi",
      ephemeralStorageRequest: "2Gi",
      ephemeralStorageLimit: "12Gi",
      workspaceSizeLimit: "8Gi",
      runtimeClassName: "gvisor",
      priorityClassName: "opengeni-sandbox",
      nodeSelector: { "sandbox.gke.io/runtime": "gvisor" },
      tolerations: [
        {
          key: "sandbox.gke.io/runtime",
          operator: "Equal",
          value: "gvisor",
          effect: "NoSchedule",
        },
      ],
    });
    let earlyIdentityCalls = 0;
    const session = await client.createWithEarlyIdentity(
      new Manifest({ root: "/workspace", entries: {}, environment: {} }),
      async (created) => {
        earlyIdentityCalls += 1;
        expect(created.state.podUid).toBe("pod-uid-1");
        expect((await readFile(logPath, "utf8")).includes('"command":"wait"')).toBe(false);
      },
    );

    expect(earlyIdentityCalls).toBe(1);
    expect(session.state.podUid).toBe("pod-uid-1");
    expect(session.state.workspaceReady).toBe(true);
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { command: string; stdin: string });
    const create = calls.find((call) => call.command === "create");
    const pod = JSON.parse(create?.stdin ?? "null") as {
      spec: {
        automountServiceAccountToken: boolean;
        runtimeClassName: string;
        priorityClassName: string;
        hostNetwork: boolean;
        hostPID: boolean;
        hostIPC: boolean;
        enableServiceLinks: boolean;
        nodeSelector: Record<string, string>;
        tolerations: Array<Record<string, unknown>>;
        securityContext: { seccompProfile: { type: string } };
        volumes: Array<{ name: string; emptyDir: { sizeLimit: string } }>;
        containers: Array<{
          resources: Record<string, Record<string, string>>;
          securityContext: Record<string, unknown>;
          volumeMounts: Array<{ name: string; mountPath: string }>;
        }>;
      };
    };
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.runtimeClassName).toBe("gvisor");
    expect(pod.spec.priorityClassName).toBe("opengeni-sandbox");
    expect(pod.spec.nodeSelector).toEqual({
      "sandbox.gke.io/runtime": "gvisor",
    });
    expect(pod.spec.tolerations).toEqual([
      {
        key: "sandbox.gke.io/runtime",
        operator: "Equal",
        value: "gvisor",
        effect: "NoSchedule",
      },
    ]);
    expect(pod.spec.hostNetwork).toBe(false);
    expect(pod.spec.hostPID).toBe(false);
    expect(pod.spec.hostIPC).toBe(false);
    expect(pod.spec.enableServiceLinks).toBe(false);
    expect(pod.spec.securityContext).toEqual({
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.spec.volumes).toEqual([{ name: "workspace", emptyDir: { sizeLimit: "8Gi" } }]);
    expect(pod.spec.containers[0]?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      privileged: false,
      capabilities: {
        drop: ["ALL"],
        add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
      },
    });
    expect(pod.spec.containers[0]?.volumeMounts).toEqual([
      { name: "workspace", mountPath: "/workspace" },
    ]);
    expect(pod.spec.containers[0]?.resources).toEqual({
      requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "2Gi" },
      limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "12Gi" },
    });

    const serialized = await client.serializeSessionState(session.state);
    const rehydrated = await client.deserializeSessionState(serialized);
    expect((await client.resumeExact(rehydrated)).state.podUid).toBe("pod-uid-1");
    await expect(
      client.resumeExact({ ...rehydrated, podUid: "different-pod-uid" }),
    ).rejects.toMatchObject({ code: "SANDBOX_NOT_FOUND" });

    await client.delete(rehydrated);
    expect((await readFile(logPath, "utf8")).includes('"command":"delete"')).toBe(true);
  });
});
