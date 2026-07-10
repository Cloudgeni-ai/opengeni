export type SelfhostedProvisioningInstructions = {
  kind: "selfhosted";
  instructions: string;
  installCommandUnix: string;
  installCommandWindows: string;
  verificationUri: string;
  note: string;
};

const HOSTED_PUBLIC_BASE_URL = "https://app.opengeni.ai";

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Build the copy-only Connected Machine bootstrap contract. This helper stays
 * pure so command quoting and the human-consent gate cannot disappear behind a
 * database-backed fleet test that is unavailable on a developer machine.
 */
export function buildSelfhostedProvisioningInstructions(input: {
  publicBaseUrl?: string | undefined;
  workspaceId: string;
}): SelfhostedProvisioningInstructions {
  const base = (input.publicBaseUrl ?? HOSTED_PUBLIC_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const installUrl = `${base}/install.sh`;
  const windowsInstallUrl = `${base}/install.ps1`;

  return {
    kind: "selfhosted",
    instructions:
      "Share these instructions with a human operator. They install the OpenGeni agent on the machine, run `opengeni-agent enroll`, complete the device-flow at the verification URL (the loud whole-machine + screen-control consent), and the machine then appears here as an attachable selfhosted sandbox.",
    // Keep the API origin + workspace binding on the shell that executes the
    // deployment-served installer. The installer prints the interactive enroll
    // step; this command never enrolls or consents on the human's behalf.
    installCommandUnix: `curl -fsSL ${shellSingleQuote(installUrl)} | OPENGENI_API_URL=${shellSingleQuote(base)} OPENGENI_WORKSPACE_ID=${shellSingleQuote(input.workspaceId)} sh`,
    installCommandWindows: `$env:OPENGENI_API_URL = ${powerShellSingleQuote(base)}; $env:OPENGENI_WORKSPACE_ID = ${powerShellSingleQuote(input.workspaceId)}; irm ${powerShellSingleQuote(windowsInstallUrl)} | iex`,
    verificationUri: `${base}/device`,
    note: "Whole-machine access requires explicit human consent in the device-flow web page; the agent cannot self-consent.",
  };
}
