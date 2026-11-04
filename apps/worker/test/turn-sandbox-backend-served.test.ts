import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import { SANDBOX_BACKEND_NOT_SERVED_CODE, SandboxBackendNotServedError } from "@opengeni/runtime";
import { assertTurnSandboxBackendServed } from "../src/activities/agent-turn/sandbox-route";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import { classifySandboxLogicalProvisionFailure } from "../src/activities/agent-turn/sandbox-provision";
import { SandboxProvisionStageError } from "../src/sandbox-resume";

function deployment(sandboxBackend: Settings["sandboxBackend"]): Settings {
  return testSettings({ sandboxBackend });
}

describe("turn-start refusal of host sandbox backends the deployment does not serve", () => {
  test("a cloud deployment refuses stored local and docker rows", () => {
    for (const deploymentBackend of ["modal", "compute", "daytona", "none"] as const) {
      for (const sessionBackend of ["local", "docker"] as const) {
        expect(() =>
          assertTurnSandboxBackendServed(deployment(deploymentBackend), sessionBackend),
        ).toThrow(SandboxBackendNotServedError);
      }
    }
  });

  test("a host deployment serves only its own host backend", () => {
    expect(() => assertTurnSandboxBackendServed(deployment("local"), "local")).not.toThrow();
    expect(() => assertTurnSandboxBackendServed(deployment("docker"), "docker")).not.toThrow();
    expect(() => assertTurnSandboxBackendServed(deployment("docker"), "local")).toThrow(
      SandboxBackendNotServedError,
    );
    expect(() => assertTurnSandboxBackendServed(deployment("local"), "docker")).toThrow(
      SandboxBackendNotServedError,
    );
  });

  test("checks the backend the turn would build, keeping existing fallbacks", () => {
    // A machine-home session falls back to the deployment default, and a
    // boxless session builds nothing: neither is refused.
    for (const deploymentBackend of ["modal", "local", "docker"] as const) {
      expect(() =>
        assertTurnSandboxBackendServed(deployment(deploymentBackend), "selfhosted"),
      ).not.toThrow();
      expect(() =>
        assertTurnSandboxBackendServed(deployment(deploymentBackend), "none"),
      ).not.toThrow();
    }
    // Remote providers keep their own credential validation at client build.
    expect(() => assertTurnSandboxBackendServed(deployment("modal"), "compute")).not.toThrow();
    expect(() => assertTurnSandboxBackendServed(deployment("modal"), "modal")).not.toThrow();
  });

  test("the refusal is a terminal, user-facing turn failure however it is wrapped", () => {
    const refusal = new SandboxBackendNotServedError("local", "modal");
    for (const error of [
      refusal,
      new SandboxProvisionStageError("create", refusal),
      new Error("establish failed", { cause: refusal }),
    ]) {
      expect(agentRunFailurePayload(error)).toEqual({
        error: refusal.message,
        code: SANDBOX_BACKEND_NOT_SERVED_CODE,
        retryable: false,
      });
    }
  });

  test("provisioning classifies the refusal as a non-retryable configuration failure", () => {
    const classified = classifySandboxLogicalProvisionFailure(
      "local",
      new SandboxProvisionStageError("create", new SandboxBackendNotServedError("local", "modal")),
    );
    expect(classified).toMatchObject({ category: "configuration", retryable: false });
  });
});
