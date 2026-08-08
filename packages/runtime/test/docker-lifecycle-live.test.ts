import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { testSettings } from "@opengeni/testing";
import {
  captureVerifiedWorkspaceArchive,
  establishSandboxSessionFromEnvelope,
  sandboxProviderContinuityForState,
  serializeEstablishedSandboxEnvelope,
  terminateManagedSandboxSession,
} from "../src/sandbox";

const execFileAsync = promisify(execFile);
const enabled = process.env.OPENGENI_DOCKER_LIFECYCLE_LIVE === "1";
const image = process.env.OPENGENI_DOCKER_LIFECYCLE_IMAGE ?? "alpine:3.20";

type DockerSession = {
  state: {
    containerId: string;
    workspaceRootPath: string;
    workspaceRootOwned: boolean;
  };
  exec(args: { cmd: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

const cleanupContainers = new Set<string>();
const cleanupRoots = new Set<string>();

afterEach(async () => {
  for (const containerId of cleanupContainers) {
    await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => undefined);
  }
  cleanupContainers.clear();
  for (const root of cleanupRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  cleanupRoots.clear();
});

describe("Docker sandbox lifecycle (live daemon)", () => {
  test.skipIf(!enabled)(
    "preserves one workspace across exact attach, continuity restart, capture, cold restore, and teardown",
    async () => {
      const workspaceBaseDir = await mkdtemp(join(tmpdir(), "opengeni-docker-lifecycle-"));
      cleanupRoots.add(workspaceBaseDir);
      const settings = testSettings({
        sandboxBackend: "docker",
        dockerImage: image,
        dockerWorkspaceBaseDir: workspaceBaseDir,
      });

      const created = await establishSandboxSessionFromEnvelope(settings, null, {
        sessionId: "docker-lifecycle-created",
        recovery: "create-or-restore",
        backendOverride: "docker",
        environment: {},
      });
      const createdSession = created.session as DockerSession;
      cleanupContainers.add(created.instanceId);
      cleanupRoots.add(createdSession.state.workspaceRootPath);
      expect(
        await createdSession.exec({
          cmd: "printf 'docker-continuity-proof' > /workspace/continuity.txt",
        }),
      ).toMatchObject({ exitCode: 0 });

      const createdEnvelope = await serializeEstablishedSandboxEnvelope(created);
      expect(createdEnvelope).not.toBeNull();
      const exact = await establishSandboxSessionFromEnvelope(settings, createdEnvelope, {
        sessionId: "docker-lifecycle-exact",
        recovery: "resume-only",
        backendOverride: "docker",
        environment: {},
      });
      expect(exact.instanceId).toBe(created.instanceId);
      expect(
        await (exact.session as DockerSession).exec({ cmd: "cat /workspace/continuity.txt" }),
      ).toMatchObject({ exitCode: 0, stdout: "docker-continuity-proof" });

      const continuity = sandboxProviderContinuityForState(
        "docker",
        created.sessionState,
        created.instanceId,
      );
      expect(continuity).not.toBeNull();
      await execFileAsync("docker", ["rm", "-f", created.instanceId]);
      cleanupContainers.delete(created.instanceId);
      const attributed: string[] = [];
      const restarted = await establishSandboxSessionFromEnvelope(
        settings,
        { ...createdEnvelope!, opengeniRecovery: { continuity } },
        {
          sessionId: "docker-lifecycle-restarted",
          recovery: "create-or-restore",
          backendOverride: "docker",
          environment: {},
          onSandboxCreated: async (established) => {
            attributed.push(established.instanceId);
          },
        },
      );
      cleanupContainers.add(restarted.instanceId);
      expect(restarted.instanceId).not.toBe(created.instanceId);
      expect(restarted.lostInstanceId).toBe(created.instanceId);
      expect(attributed).toEqual([restarted.instanceId]);
      expect(
        await (restarted.session as DockerSession).exec({
          cmd: "cat /workspace/continuity.txt",
        }),
      ).toMatchObject({ exitCode: 0, stdout: "docker-continuity-proof" });

      const archive = await captureVerifiedWorkspaceArchive(restarted.session);
      expect(archive.kind).toBe("tar");
      await terminateManagedSandboxSession(
        restarted.client,
        restarted.sessionState,
        restarted.session,
      );
      cleanupContainers.delete(restarted.instanceId);

      const restored = await establishSandboxSessionFromEnvelope(
        settings,
        {
          backendId: "docker",
          sessionState: {
            workspaceArchive: archive.base64,
            workspaceArchiveMeta: archive.descriptor,
          },
        },
        {
          sessionId: "docker-lifecycle-restored",
          recovery: "create-or-restore",
          backendOverride: "docker",
          environment: {},
        },
      );
      cleanupContainers.add(restored.instanceId);
      expect(restored.origin).toBe("restored");
      expect(
        await (restored.session as DockerSession).exec({ cmd: "cat /workspace/continuity.txt" }),
      ).toMatchObject({ exitCode: 0, stdout: "docker-continuity-proof" });
      await terminateManagedSandboxSession(
        restored.client,
        restored.sessionState,
        restored.session,
      );
      cleanupContainers.delete(restored.instanceId);
    },
    180_000,
  );
});
