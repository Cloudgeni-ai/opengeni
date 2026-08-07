import { describe, expect, test } from "bun:test";
import { deviceVerificationUri, installOneLiner } from "./deployment";

describe("Connected Machine deployment URLs", () => {
  test("builds an additive token connect command pinned to this deployment", () => {
    const command = installOneLiner("https://one.opengeni.example/", {
      enrollToken: "oget_example",
    });

    expect(command).toBe(
      "curl -fsSL https://one.opengeni.example/install.sh | " +
        "OPENGENI_API_URL=https://one.opengeni.example " +
        "OPENGENI_ENROLL_TOKEN=oget_example sh",
    );
    expect(command).not.toContain("--force");
  });

  test("pins interactive setup and approval to the selected deployment", () => {
    expect(
      installOneLiner("https://two.opengeni.example///", { workspaceId: "workspace-2" }),
    ).toContain(
      "OPENGENI_API_URL=https://two.opengeni.example OPENGENI_WORKSPACE_ID=workspace-2 sh",
    );
    expect(deviceVerificationUri("https://two.opengeni.example/")).toBe(
      "https://two.opengeni.example/device",
    );
  });
});
