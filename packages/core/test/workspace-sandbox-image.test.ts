import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { settingsWithWorkspaceSandboxImage } from "../src/sandbox/runtime-settings";

describe("workspace default sandbox image", () => {
  const settings = testSettings({
    dockerImage: "opengeni-sandbox:deployment",
    modalImageRef: "ghcr.io/opengeni/sandbox@sha256:deployment",
    modalImageId: "im-deployment",
    sandboxImageAllowlist: "ghcr.io/acme/sandbox:1,ghcr.io/acme/sandbox:2",
  });

  test("applies an allowlisted image to Docker and Modal", () => {
    const workspace = { defaultSandboxImage: "ghcr.io/acme/sandbox:2" };
    expect(settingsWithWorkspaceSandboxImage(settings, workspace, "docker").dockerImage).toBe(
      "ghcr.io/acme/sandbox:2",
    );
    const modal = settingsWithWorkspaceSandboxImage(settings, workspace, "modal");
    expect(modal.modalImageRef).toBe("ghcr.io/acme/sandbox:2");
    expect(modal.modalImageId).toBeUndefined();
  });

  test("keeps the deployment image when the selection is absent or no longer allowed", () => {
    expect(settingsWithWorkspaceSandboxImage(settings, {}, "docker")).toBe(settings);
    expect(
      settingsWithWorkspaceSandboxImage(
        settings,
        { defaultSandboxImage: "ghcr.io/acme/removed:1" },
        "docker",
      ),
    ).toBe(settings);
    expect(
      settingsWithWorkspaceSandboxImage(
        { ...settings, sandboxImageAllowlist: "" },
        { defaultSandboxImage: "ghcr.io/acme/sandbox:1" },
        "modal",
      ),
    ).toMatchObject({ modalImageId: "im-deployment" });
  });

  test("other backends are unchanged", () => {
    expect(
      settingsWithWorkspaceSandboxImage(
        settings,
        { defaultSandboxImage: "ghcr.io/acme/sandbox:1" },
        "local",
      ),
    ).toBe(settings);
  });
});
