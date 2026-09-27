import type { CodeSearchDeploymentPolicy } from "@opengeni/contracts/code-search";

/**
 * The deployment's `code_search` policy (`OPENGENI_CODE_SEARCH_MODE` plus a
 * usable `OPENGENI_JEV_API_KEY`), parsed once at boot by `@opengeni/config`
 * (`codeSearchDeploymentPolicy(settings)`) and installed here by the API app
 * and both worker roles. `createSession` reads it only to freeze a new root
 * session's decision. A process that never installs it freezes new sessions
 * off.
 */
let installedCodeSearchPolicy: CodeSearchDeploymentPolicy = {
  available: false,
  workspaceDefault: "off",
};

export function configureCodeSearchDeploymentPolicy(policy: CodeSearchDeploymentPolicy): void {
  installedCodeSearchPolicy = {
    available: policy.available,
    workspaceDefault: policy.workspaceDefault,
  };
}

export function codeSearchDeploymentPolicyForCreate(): CodeSearchDeploymentPolicy {
  return installedCodeSearchPolicy;
}
