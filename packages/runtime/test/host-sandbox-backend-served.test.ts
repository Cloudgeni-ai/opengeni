import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { SandboxBackend } from "@opengeni/contracts";
import {
  getSettings,
  isHostSandboxBackend,
  UNSERVED_HOST_SANDBOX_BACKEND_MESSAGE,
  type Settings,
} from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  PROVIDER_REGISTRY,
  SANDBOX_BACKEND_NOT_SERVED_CODE,
  SandboxBackendNotServedError,
  SandboxConfigError,
  assertHostSandboxBackendServed,
  createSandboxClientForBackend,
  establishSandboxSessionFromEnvelope,
} from "../src/index";

// Whether a box may run as processes on this host is a deployment choice. It
// must never follow from what the host image happens to contain: this test
// process has a working runtime and a writable temp directory, so the local
// provider is fully usable here, and it is still refused unless the settings
// in hand name it as the default.

type LiveLocalSession = {
  closed: boolean;
  state: { workspaceRootPath: string };
  close: () => Promise<void>;
  exec: (args: { cmd: string }) => Promise<{ stdout?: string; exitCode?: number }>;
};

const liveSessions: LiveLocalSession[] = [];
afterEach(async () => {
  for (const session of liveSessions.splice(0)) {
    if (!session.closed) await session.close().catch(() => undefined);
  }
});

const hostBackends = SandboxBackend.options.filter((backend) => isHostSandboxBackend(backend));
const remoteDefaults = SandboxBackend.options.filter((backend) => !isHostSandboxBackend(backend));

function settingsWithDefault(sandboxBackend: Settings["sandboxBackend"]): Settings {
  return testSettings({ sandboxBackend, webSearchEnabled: false });
}

describe("host sandbox backends are built only as the configured default", () => {
  test("the host backends are exactly local and docker", () => {
    expect(hostBackends).toEqual(["docker", "local"]);
  });

  test("the local provider works in this process when it is the default", async () => {
    const client = createSandboxClientForBackend("local", settingsWithDefault("local")) as {
      create: (manifest?: unknown) => Promise<LiveLocalSession>;
    };
    const session = await client.create({});
    liveSessions.push(session);
    expect(existsSync(session.state.workspaceRootPath)).toBe(true);
    const result = await session.exec({ cmd: "echo host-runnable" });
    expect(String(result.stdout ?? "")).toContain("host-runnable");
  });

  for (const deploymentBackend of remoteDefaults) {
    for (const hostBackend of hostBackends) {
      test(`default ${deploymentBackend} refuses to build a ${hostBackend} client`, () => {
        const settings = settingsWithDefault(deploymentBackend);
        const build = spyOn(PROVIDER_REGISTRY[hostBackend], "build");
        const validate = spyOn(PROVIDER_REGISTRY[hostBackend], "validateCredentials");
        try {
          let thrown: unknown;
          try {
            createSandboxClientForBackend(hostBackend, settings);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(SandboxBackendNotServedError);
          // Still a configuration failure: provisioning classifies it as
          // terminal and non-retryable.
          expect(thrown).toBeInstanceOf(SandboxConfigError);
          expect((thrown as SandboxBackendNotServedError).code).toBe(
            SANDBOX_BACKEND_NOT_SERVED_CODE,
          );
          expect((thrown as SandboxBackendNotServedError).backend).toBe(hostBackend);
          expect(build).not.toHaveBeenCalled();
          expect(validate).not.toHaveBeenCalled();
        } finally {
          build.mockRestore();
          validate.mockRestore();
        }
      });
    }
  }

  test("one host backend never serves the other", () => {
    expect(() => assertHostSandboxBackendServed(settingsWithDefault("docker"), "local")).toThrow(
      SandboxBackendNotServedError,
    );
    expect(() => assertHostSandboxBackendServed(settingsWithDefault("local"), "docker")).toThrow(
      SandboxBackendNotServedError,
    );
    expect(() =>
      assertHostSandboxBackendServed(settingsWithDefault("docker"), "docker"),
    ).not.toThrow();
    expect(() =>
      assertHostSandboxBackendServed(settingsWithDefault("local"), "local"),
    ).not.toThrow();
  });

  test("remote providers are left to their own credential validation", () => {
    for (const backend of remoteDefaults) {
      expect(() =>
        assertHostSandboxBackendServed(settingsWithDefault("local"), backend),
      ).not.toThrow();
    }
  });

  test("an explicit backend override cannot create a host box the default does not serve", async () => {
    const build = spyOn(PROVIDER_REGISTRY.local, "build");
    try {
      await expect(
        establishSandboxSessionFromEnvelope(settingsWithDefault("modal"), null, {
          sessionId: "sess-unserved-local",
          recovery: "create-or-restore",
          backendOverride: "local",
        }),
      ).rejects.toBeInstanceOf(SandboxBackendNotServedError);
      expect(build).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
    }
  });

  test("a stored envelope naming a host backend cannot create one either", async () => {
    const build = spyOn(PROVIDER_REGISTRY.docker, "build");
    try {
      await expect(
        establishSandboxSessionFromEnvelope(
          settingsWithDefault("compute"),
          { backendId: "docker" },
          { sessionId: "sess-unserved-docker", recovery: "create-or-restore" },
        ),
      ).rejects.toBeInstanceOf(SandboxBackendNotServedError);
      expect(build).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
    }
  });

  test("a session-rebound settings object cannot serve its own host backend", async () => {
    // API and worker code rebinds settings to a session's stored backend
    // ({...settings, sandboxBackend: session.sandboxBackend}) before building
    // that session's box. The deployment default survives the spread.
    const modal = getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_SANDBOX_BACKEND: "modal",
      OPENGENI_MODAL_APP_NAME: "opengeni",
      OPENGENI_MODAL_TOKEN_ID: "id",
      OPENGENI_MODAL_TOKEN_SECRET: "secret",
    });
    for (const hostBackend of hostBackends) {
      const rebound: Settings = { ...modal, sandboxBackend: hostBackend };
      const build = spyOn(PROVIDER_REGISTRY[hostBackend], "build");
      try {
        expect(() => createSandboxClientForBackend(hostBackend, rebound)).toThrow(
          SandboxBackendNotServedError,
        );
        await expect(
          establishSandboxSessionFromEnvelope(rebound, null, {
            sessionId: `sess-rebound-${hostBackend}`,
            recovery: "create-or-restore",
            backendOverride: hostBackend,
          }),
        ).rejects.toBeInstanceOf(SandboxBackendNotServedError);
        expect(build).not.toHaveBeenCalled();
      } finally {
        build.mockRestore();
      }
    }
    const local = getSettings({ OPENGENI_ENV: "test", OPENGENI_SANDBOX_BACKEND: "local" });
    expect(() =>
      assertHostSandboxBackendServed({ ...local, sandboxBackend: "modal" }, "local"),
    ).not.toThrow();
    expect(() =>
      assertHostSandboxBackendServed({ ...local, sandboxBackend: "docker" }, "docker"),
    ).toThrow(SandboxBackendNotServedError);
  });

  test("the refusal tells the person what happened and what to do, in plain words", () => {
    const error = new SandboxBackendNotServedError("local", "modal");
    expect(error.message).toBe(UNSERVED_HOST_SANDBOX_BACKEND_MESSAGE);
    expect(error.message).toContain("no sandbox was started and nothing ran");
    expect(error.message).toContain("Start a new chat");
    expect(error.message).not.toMatch(/"(local|docker|modal)"/);
    expect(error.backend).toBe("local");
    expect(error.deploymentBackend).toBe("modal");
  });
});
