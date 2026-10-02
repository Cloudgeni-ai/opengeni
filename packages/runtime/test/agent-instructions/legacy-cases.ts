import type { BuildAgentOptions } from "../../src/index";

/**
 * Representative legacy (null agent configuration) composition inputs. The
 * lock test pins the exact composed bytes for each; they were recorded before
 * the modular composer existed and must never change.
 */
export const LEGACY_PROMPT_CASES: Record<string, BuildAgentOptions> = {
  default: {},
  environment_and_rig: {
    workspaceEnvironment: {
      name: "prod",
      description: "Use DEPLOY_KEY for deploys.",
      variableNames: ["DEPLOY_KEY", "API_URL"],
    },
    rig: { name: "python", version: 3 },
  },
  custom_template_with_marker: {
    instructionsTemplate: "You are Acme Assistant, the AI assistant for Acme Corp. {{core}}",
  },
  custom_template_without_marker: {
    instructionsTemplate: "You are Acme Assistant, the AI assistant for Acme Corp.",
  },
  extras_without_governance: {
    codemodeAvailable: true,
    codeSearchAvailable: true,
    gitCredentialBindings: [
      { credentialBindingId: "a", provider: "github", token: "x" },
      { credentialBindingId: "b", provider: "github", token: "y" },
    ],
    workspaceMemory: "Legacy memory block.",
    sessionInstructions: "Always answer in exactly one sentence.",
    skillCatalog: [],
  },
  extras_with_governance: {
    codemodeAvailable: true,
    codeSearchAvailable: true,
    workspaceGovernance: "Workspace charter: be kind.",
    workspaceMemory: "Legacy memory block.",
    sessionInstructions: "Always answer in exactly one sentence.",
  },
  selfhosted_with_bindings: {
    activeSandboxBackend: "selfhosted",
    gitCredentialBindings: [
      { credentialBindingId: "a", provider: "github", token: "x" },
      { credentialBindingId: "b", provider: "github", token: "y" },
    ],
  },
};
