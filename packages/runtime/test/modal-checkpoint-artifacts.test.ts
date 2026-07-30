import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  deleteModalCheckpointSnapshot,
  inspectModalSandboxLifecycle,
  modalSessionMatchesCheckpointProviderBinding,
  resolveModalCheckpointProviderBinding,
  resolveModalCheckpointProviderBindingForLiveSandbox,
  resolveModalCheckpointProviderBindingForSession,
} from "../src/sandbox/providers/modal";

function fakeModalClient(input?: {
  workspaceName?: string;
  profileEnvironment?: string;
  identityError?: unknown;
  deleteError?: unknown;
  sandboxError?: unknown;
  sandboxExitCode?: number | null;
}) {
  const deleted: string[] = [];
  let closed = false;
  const client = {
    cpClient: {
      workspaceNameLookup: async () => {
        if (input?.identityError) throw input.identityError;
        return {
          workspaceName: input?.workspaceName ?? "workspace-a",
          username: "fallback-user",
        };
      },
    },
    profile: { serverUrl: "https://api.modal.test" },
    environmentName: (environment?: string) => environment || input?.profileEnvironment || "",
    images: {
      delete: async (snapshotId: string) => {
        if (input?.deleteError) throw input.deleteError;
        deleted.push(snapshotId);
      },
    },
    sandboxes: {
      fromId: async (_sandboxId: string) => {
        if (input?.sandboxError) throw input.sandboxError;
        return {
          poll: async () => input?.sandboxExitCode ?? null,
        };
      },
    },
    close: () => {
      closed = true;
    },
  };
  return {
    client,
    deleted,
    isClosed: () => closed,
    factory: async () => client as never,
  };
}

describe("Modal checkpoint provider binding", () => {
  test("persists only the non-secret authoritative workspace binding", async () => {
    const fake = fakeModalClient();
    const settings = testSettings({
      modalTokenId: "token-id",
      modalTokenSecret: "token-secret",
      modalEnvironment: "production",
    });

    const resolved = await resolveModalCheckpointProviderBinding(settings, fake.factory);

    expect(resolved).toEqual({
      key: JSON.stringify({
        version: 1,
        serverUrl: "https://api.modal.test",
        workspaceName: "workspace-a",
        environment: "production",
      }),
      binding: {
        version: 1,
        serverUrl: "https://api.modal.test",
        workspaceName: "workspace-a",
        environment: "production",
      },
    });
    expect(resolved.key).not.toContain("token-id");
    expect(resolved.key).not.toContain("token-secret");
    expect(fake.isClosed()).toBe(true);
  });

  test("binds the effective profile environment when no override is configured", async () => {
    const fake = fakeModalClient({ profileEnvironment: "profile-main" });

    await expect(
      resolveModalCheckpointProviderBinding(testSettings(), fake.factory),
    ).resolves.toMatchObject({
      binding: { environment: "profile-main" },
    });
    expect(fake.isClosed()).toBe(true);
  });

  test("checks identity and deletes through one exact client", async () => {
    const fake = fakeModalClient();
    const settings = testSettings({ modalEnvironment: "main" });
    const bindingKey = JSON.stringify({
      version: 1,
      serverUrl: "https://api.modal.test",
      workspaceName: "workspace-a",
      environment: "main",
    });

    await expect(
      deleteModalCheckpointSnapshot(settings, bindingKey, "im-123", fake.factory),
    ).resolves.toBe("deleted");
    expect(fake.deleted).toEqual(["im-123"]);
    expect(fake.isClosed()).toBe(true);
  });

  test("binds capture to the exact live session client without closing it", async () => {
    const fake = fakeModalClient();
    const settings = testSettings({ modalEnvironment: "main" });
    const resolved = await resolveModalCheckpointProviderBindingForSession(settings, {
      modal: fake.client,
    });

    expect(resolved.key).toBe(
      JSON.stringify({
        version: 1,
        serverUrl: "https://api.modal.test",
        workspaceName: "workspace-a",
        environment: "main",
      }),
    );
    expect(fake.isClosed()).toBe(false);
  });

  test("matches restore ownership against the exact created session client", async () => {
    const fake = fakeModalClient();
    const settings = testSettings({ modalEnvironment: "main" });
    const session = { modal: fake.client };
    const correct = JSON.stringify({
      version: 1,
      serverUrl: "https://api.modal.test",
      workspaceName: "workspace-a",
      environment: "main",
    });
    const wrong = JSON.stringify({
      version: 1,
      serverUrl: "https://api.modal.test",
      workspaceName: "workspace-b",
      environment: "main",
    });

    await expect(
      modalSessionMatchesCheckpointProviderBinding(settings, session, correct),
    ).resolves.toBe(true);
    await expect(
      modalSessionMatchesCheckpointProviderBinding(settings, session, wrong),
    ).resolves.toBe(false);
    expect(fake.isClosed()).toBe(false);
  });

  test("adopts legacy ownership only after the same namespace proves the box live", async () => {
    const fake = fakeModalClient();
    const settings = testSettings({ modalEnvironment: "main" });

    await expect(
      resolveModalCheckpointProviderBindingForLiveSandbox(settings, "sb-live", fake.factory),
    ).resolves.toMatchObject({
      binding: { workspaceName: "workspace-a", environment: "main" },
    });
    expect(fake.isClosed()).toBe(true);

    const exited = fakeModalClient({ sandboxExitCode: 137 });
    await expect(
      resolveModalCheckpointProviderBindingForLiveSandbox(settings, "sb-dead", exited.factory),
    ).rejects.toThrow("no longer running");
    expect(exited.isClosed()).toBe(true);
  });

  test("fails closed before deletion when the credential workspace changed", async () => {
    const fake = fakeModalClient({ workspaceName: "workspace-b" });
    const settings = testSettings({ modalEnvironment: "main" });
    const staleBindingKey = JSON.stringify({
      version: 1,
      serverUrl: "https://api.modal.test",
      workspaceName: "workspace-a",
      environment: "main",
    });

    await expect(
      deleteModalCheckpointSnapshot(settings, staleBindingKey, "im-123", fake.factory),
    ).rejects.toThrow("configured credential workspace changed");
    expect(fake.deleted).toEqual([]);
    expect(fake.isClosed()).toBe(true);
  });

  test("treats provider NotFound as idempotent deletion success", async () => {
    const notFound = Object.assign(new Error("image not found"), { code: 5 });
    const fake = fakeModalClient({ deleteError: notFound });
    const settings = testSettings();
    const bindingKey = JSON.stringify({
      version: 1,
      serverUrl: "https://api.modal.test",
      workspaceName: "workspace-a",
      environment: "",
    });

    await expect(
      deleteModalCheckpointSnapshot(settings, bindingKey, "im-gone", fake.factory),
    ).resolves.toBe("not_found");
    expect(fake.isClosed()).toBe(true);
  });

  test("does not turn arbitrary message text into deletion proof", async () => {
    const transportFailure = new Error("proxy route not found while deleting image");
    const fake = fakeModalClient({ deleteError: transportFailure });
    const settings = testSettings();
    const bindingKey = JSON.stringify({
      version: 1,
      serverUrl: "https://api.modal.test",
      workspaceName: "workspace-a",
      environment: "",
    });

    await expect(
      deleteModalCheckpointSnapshot(settings, bindingKey, "im-unknown", fake.factory),
    ).rejects.toThrow("proxy route not found");
    expect(fake.isClosed()).toBe(true);
  });

  test("never mistakes an identity-probe NotFound for snapshot deletion", async () => {
    const fake = fakeModalClient({
      identityError: Object.assign(new Error("workspace not found"), { code: 5 }),
    });
    const settings = testSettings();
    const bindingKey = JSON.stringify({
      version: 1,
      serverUrl: "https://api.modal.test",
      workspaceName: "workspace-a",
      environment: "",
    });

    await expect(
      deleteModalCheckpointSnapshot(settings, bindingKey, "im-still-owned", fake.factory),
    ).rejects.toThrow("workspace not found");
    expect(fake.deleted).toEqual([]);
    expect(fake.isClosed()).toBe(true);
  });

  test("inspects one historical sandbox lifecycle without a lease envelope", async () => {
    const settings = testSettings();
    const providerBinding = {
      providerBindingKey: JSON.stringify({
        version: 1,
        serverUrl: "https://api.modal.test",
        workspaceName: "workspace-a",
        environment: "",
      }),
      providerBinding: {
        version: 1 as const,
        serverUrl: "https://api.modal.test",
        workspaceName: "workspace-a",
        environment: "",
      },
    };
    const running = fakeModalClient({ sandboxExitCode: null });
    await expect(
      inspectModalSandboxLifecycle(settings, "sb-running", null, running.factory),
    ).resolves.toEqual({ status: "running", ...providerBinding });
    expect(running.isClosed()).toBe(true);

    const terminated = fakeModalClient({ sandboxExitCode: 137 });
    await expect(
      inspectModalSandboxLifecycle(settings, "sb-terminated", null, terminated.factory),
    ).resolves.toEqual({ status: "terminated", exitCode: 137, ...providerBinding });
    expect(terminated.isClosed()).toBe(true);

    const missing = fakeModalClient({
      sandboxError: Object.assign(new Error("sandbox not found"), { code: 5 }),
    });
    await expect(
      inspectModalSandboxLifecycle(settings, "sb-missing", null, missing.factory),
    ).resolves.toEqual({ status: "not_found", ...providerBinding });
    expect(missing.isClosed()).toBe(true);
  });
});
