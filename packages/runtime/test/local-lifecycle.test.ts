import { afterEach, describe, expect, test } from "bun:test";
import { access, rm } from "node:fs/promises";
import { testSettings } from "@opengeni/testing";
import {
  captureVerifiedWorkspaceArchive,
  establishSandboxSessionFromEnvelope,
  serializeEstablishedSandboxEnvelope,
  terminateManagedSandboxSession,
} from "../src/sandbox";

const cleanupRoots = new Set<string>();

type LocalSession = {
  state: { workspaceRootPath: string };
  exec(args: { cmd: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

afterEach(async () => {
  for (const root of cleanupRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  cleanupRoots.clear();
});

describe("Local sandbox lifecycle", () => {
  test.skipIf(process.platform === "win32")(
    "preserves one workspace across exact attach, verified capture, cold restore, and teardown",
    async () => {
      const settings = testSettings({ sandboxBackend: "local" });
      const created = await establishSandboxSessionFromEnvelope(settings, null, {
        sessionId: "local-lifecycle-created",
        recovery: "create-or-restore",
        backendOverride: "local",
        environment: {},
      });
      const createdSession = created.session as LocalSession;
      cleanupRoots.add(createdSession.state.workspaceRootPath);
      expect(
        await createdSession.exec({
          cmd: "printf 'local-continuity-proof' > /workspace/continuity.txt",
        }),
      ).toMatchObject({ exitCode: 0 });

      const createdEnvelope = await serializeEstablishedSandboxEnvelope(created);
      expect(createdEnvelope).not.toBeNull();
      const exact = await establishSandboxSessionFromEnvelope(settings, createdEnvelope, {
        sessionId: "local-lifecycle-exact",
        recovery: "resume-only",
        backendOverride: "local",
        environment: {},
      });
      expect(exact.instanceId).toBe(created.instanceId);
      expect(
        await (exact.session as LocalSession).exec({ cmd: "cat /workspace/continuity.txt" }),
      ).toMatchObject({ exitCode: 0, stdout: "local-continuity-proof" });

      const archive = await captureVerifiedWorkspaceArchive(exact.session);
      expect(archive.kind).toBe("tar");
      expect(archive.descriptor.workspace.projection).toBe("sdk_local_archive_v1");
      await terminateManagedSandboxSession(exact.client, exact.sessionState, exact.session);
      await expect(access(createdSession.state.workspaceRootPath)).rejects.toBeDefined();
      cleanupRoots.delete(createdSession.state.workspaceRootPath);

      const restored = await establishSandboxSessionFromEnvelope(
        settings,
        {
          backendId: "local",
          sessionState: {
            workspaceArchive: archive.base64,
            workspaceArchiveMeta: archive.descriptor,
          },
        },
        {
          sessionId: "local-lifecycle-restored",
          recovery: "create-or-restore",
          backendOverride: "local",
          environment: {},
        },
      );
      const restoredSession = restored.session as LocalSession;
      cleanupRoots.add(restoredSession.state.workspaceRootPath);
      expect(restored.origin).toBe("restored");
      expect(await restoredSession.exec({ cmd: "cat /workspace/continuity.txt" })).toMatchObject({
        exitCode: 0,
        stdout: "local-continuity-proof",
      });
      await terminateManagedSandboxSession(
        restored.client,
        restored.sessionState,
        restored.session,
      );
      cleanupRoots.delete(restoredSession.state.workspaceRootPath);
    },
    30_000,
  );
});
