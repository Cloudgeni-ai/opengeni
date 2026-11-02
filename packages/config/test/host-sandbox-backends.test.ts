import { describe, expect, test } from "bun:test";
import { SandboxBackend } from "@opengeni/contracts";
import {
  deploymentSandboxBackend,
  getSettings,
  hostSandboxBackendRefused,
  isHostSandboxBackend,
  requiredSandboxEnvForBackend,
  sandboxBackendServed,
} from "../src";

// Host backends carry no credentials, so nothing about the environment (an
// installed runtime, a Docker socket, a configured secret) can make them look
// chosen. These invariants keep that classification complete as backends are
// added: a backend that needs no credentials must be classified explicitly.
describe("host sandbox backends", () => {
  test("are exactly local and docker", () => {
    expect(SandboxBackend.options.filter((backend) => isHostSandboxBackend(backend))).toEqual([
      "docker",
      "local",
    ]);
  });

  test("every credential-free backend is classified: host, none or a Connected Machine", () => {
    const credentialFree = SandboxBackend.options.filter(
      (backend) => requiredSandboxEnvForBackend(backend).length === 0,
    );
    for (const backend of credentialFree) {
      expect(isHostSandboxBackend(backend) || backend === "none" || backend === "selfhosted").toBe(
        true,
      );
    }
  });

  test("are served only as the default, whatever else is configured", () => {
    const everything = {
      OPENGENI_ENV: "test",
      OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "true",
      OPENGENI_MODAL_APP_NAME: "opengeni",
      OPENGENI_MODAL_TOKEN_ID: "id",
      OPENGENI_MODAL_TOKEN_SECRET: "secret",
      OPENGENI_COMPUTE_API_URL: "https://compute.example",
      OPENGENI_COMPUTE_API_KEY: "key",
    };
    const modal = getSettings({ ...everything, OPENGENI_SANDBOX_BACKEND: "modal" });
    expect(sandboxBackendServed(modal, "compute")).toBe(true);
    expect(sandboxBackendServed(modal, "local")).toBe(false);
    expect(sandboxBackendServed(modal, "docker")).toBe(false);
    const local = getSettings({ ...everything, OPENGENI_SANDBOX_BACKEND: "local" });
    expect(sandboxBackendServed(local, "local")).toBe(true);
    expect(sandboxBackendServed(local, "docker")).toBe(false);
  });

  test("the deployment default survives a per-session rebind", () => {
    const modal = getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_SANDBOX_BACKEND: "modal",
      OPENGENI_MODAL_APP_NAME: "opengeni",
      OPENGENI_MODAL_TOKEN_ID: "id",
      OPENGENI_MODAL_TOKEN_SECRET: "secret",
    });
    expect(modal.deploymentSandboxBackend).toBe("modal");
    for (const backend of ["local", "docker"] as const) {
      // Session code spreads the session's stored backend into settings.
      const rebound = { ...modal, sandboxBackend: backend };
      expect(deploymentSandboxBackend(rebound)).toBe("modal");
      expect(hostSandboxBackendRefused(rebound, backend)).toBe(true);
    }
    expect(hostSandboxBackendRefused({ ...modal, sandboxBackend: "compute" }, "compute")).toBe(
      false,
    );
    const local = getSettings({ OPENGENI_ENV: "test", OPENGENI_SANDBOX_BACKEND: "local" });
    expect(hostSandboxBackendRefused({ ...local, sandboxBackend: "modal" }, "local")).toBe(false);
    expect(hostSandboxBackendRefused(local, "docker")).toBe(true);
  });

  test("hand-built settings without the field fall back to sandboxBackend", () => {
    const { deploymentSandboxBackend: _omitted, ...handBuilt } = getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_SANDBOX_BACKEND: "docker",
    });
    expect(deploymentSandboxBackend(handBuilt)).toBe("docker");
    expect(hostSandboxBackendRefused(handBuilt, "docker")).toBe(false);
    expect(hostSandboxBackendRefused(handBuilt, "local")).toBe(true);
  });
});
