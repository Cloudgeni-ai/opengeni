import { describe, expect, test } from "bun:test";
import { buildSelfhostedProvisioningInstructions } from "../src/sandbox/selfhosted-provisioning";

describe("Connected Machine provisioning command contract", () => {
  test("pins the deployment API origin and workspace in exact POSIX and PowerShell commands", () => {
    const result = buildSelfhostedProvisioningInstructions({
      publicBaseUrl: "https://api.example.test/root'quote///",
      workspaceId: "workspace'quoted",
    });

    expect(result).toEqual({
      kind: "selfhosted",
      instructions:
        "Share these instructions with a human operator. They install the OpenGeni agent on the machine, run `opengeni-agent enroll`, complete the device-flow at the verification URL (the loud whole-machine + screen-control consent), and the machine then appears here as an attachable selfhosted sandbox.",
      installCommandUnix:
        `curl -fsSL 'https://api.example.test/root'"'"'quote/install.sh' | ` +
        `OPENGENI_API_URL='https://api.example.test/root'"'"'quote' ` +
        `OPENGENI_WORKSPACE_ID='workspace'"'"'quoted' sh`,
      installCommandWindows:
        `$env:OPENGENI_API_URL = 'https://api.example.test/root''quote'; ` +
        `$env:OPENGENI_WORKSPACE_ID = 'workspace''quoted'; ` +
        `irm 'https://api.example.test/root''quote/install.ps1' | iex`,
      verificationUri: "https://api.example.test/root'quote/device",
      note: "Whole-machine access requires explicit human consent in the device-flow web page; the agent cannot self-consent.",
    });
  });

  test("uses the real hosted origin when a deployment base URL is absent", () => {
    const result = buildSelfhostedProvisioningInstructions({
      workspaceId: "workspace-id",
    });

    expect(result.installCommandUnix).toBe(
      "curl -fsSL 'https://app.opengeni.ai/install.sh' | OPENGENI_API_URL='https://app.opengeni.ai' OPENGENI_WORKSPACE_ID='workspace-id' sh",
    );
    expect(result.installCommandWindows).toBe(
      "$env:OPENGENI_API_URL = 'https://app.opengeni.ai'; $env:OPENGENI_WORKSPACE_ID = 'workspace-id'; irm 'https://app.opengeni.ai/install.ps1' | iex",
    );
    expect(result.verificationUri).toBe("https://app.opengeni.ai/device");
    expect(`${result.instructions} ${result.note}`).toContain("human");
    expect(`${result.instructions} ${result.note}`).toContain("whole-machine");
    expect(
      `${result.installCommandUnix} ${result.installCommandWindows}`,
    ).not.toContain("--token");
  });
});
