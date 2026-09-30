import type { OrganizationModelProviderKind as ProviderKind } from "@opengeni/sdk";
import type { ProviderPresentation } from "@/components/ai-gateway-connection";

// Dependency-free presentation data shared by workspace and organization connections.
export const ORGANIZATION_PROVIDER_META: Record<
  ProviderKind,
  ProviderPresentation & { shortName: string }
> = {
  anthropic: {
    title: "Anthropic API",
    shortName: "Anthropic",
    provider: "anthropic",
    billedTo: "The organization's Anthropic API account",
    summary: "Use Claude with an API key. Usage is billed by Anthropic.",
    keyHelp:
      "Create a key in the Anthropic Console. Claude subscription tokens belong in the separate Claude subscription connection.",
    keyAriaLabel: "Anthropic API key",
    credentialLabelText: "API key",
    customModelsHeading: "Claude models",
    customModelsDescription:
      "Choose models for your workspaces. Availability depends on your Anthropic account.",
    customModelInputAriaLabel: "Anthropic model ID",
    customModelPlaceholder: "Claude model ID",
    emptyCustomModelsDescription: "Add a Claude model to make it available in your workspaces.",
    readyModelDescription: "Available where connection access allows",
    waitingModelDescription: "Waiting for an Anthropic API key",
    unavailableModelDescription: "Connection status unavailable",
    modelToastName: "Claude model",
    connectionManagerDescription: "",
  },
  claude_subscription: {
    title: "Claude subscription",
    shortName: "Claude",
    provider: "claude_subscription",
    billedTo: "The connected Claude subscription",
    summary: "Use your Claude plan in OpenGeni. Sign in to check usage and reset times.",
    keyHelp:
      "Run claude setup-token in your terminal, then paste the token here. The token uses your subscription limits. Replace it when it expires or is revoked; OpenGeni does not refresh setup tokens.",
    keyAriaLabel: "Claude subscription setup token",
    credentialLabelText: "Sign-in",
    customModelsHeading: "Claude models",
    customModelsDescription:
      "Choose models for your workspaces. Availability depends on your Claude plan.",
    customModelInputAriaLabel: "Claude subscription model ID",
    customModelPlaceholder: "Claude model ID",
    emptyCustomModelsDescription: "Add a Claude model to make it available in your workspaces.",
    readyModelDescription: "Uses the connected Claude subscription",
    waitingModelDescription: "Waiting for a setup token",
    unavailableModelDescription: "Connection status unavailable",
    modelToastName: "Claude model",
    connectionManagerDescription: "",
  },
  vercel_gateway: {
    title: "Vercel AI Gateway",
    shortName: "Gateway",
    provider: "vercel",
    billedTo: "The organization's Vercel account",
    summary:
      "Use models through the organization's Vercel account in shared workspaces, billed to Vercel.",
    keyHelp: "Create one in Vercel under AI Gateway, then API keys.",
    keyAriaLabel: "Organization Vercel AI Gateway API key",
    customModelsHeading: "Custom models",
    customModelsDescription:
      "Exact Vercel model slugs shared workspaces can pick. Workspace Allowed models can limit them further.",
    customModelInputAriaLabel: "Vercel AI Gateway organization model slug",
    customModelPlaceholder: "anthropic/claude-sonnet-4.6",
    emptyCustomModelsDescription: "No custom models yet. Add one to offer it in shared workspaces.",
    readyModelDescription: "Ready in shared workspaces",
    waitingModelDescription: "Waiting for a Gateway key",
    unavailableModelDescription: "Connection status unavailable",
    modelToastName: "Vercel AI Gateway model",
    connectionManagerDescription: "",
  },
  openrouter: {
    title: "OpenRouter",
    shortName: "OpenRouter",
    provider: "openrouter",
    billedTo: "The organization's OpenRouter account",
    summary:
      "Use models through the organization's OpenRouter account in shared workspaces, billed to OpenRouter.",
    keyHelp: "Create one on openrouter.ai under Keys.",
    keyAriaLabel: "Organization OpenRouter API key",
    customModelsHeading: "Custom models",
    customModelsDescription:
      "Exact OpenRouter model slugs shared workspaces can pick. Separate from deployment-provided OpenRouter models.",
    customModelInputAriaLabel: "OpenRouter organization model slug",
    customModelPlaceholder: "anthropic/claude-sonnet-4.6",
    emptyCustomModelsDescription: "No custom models yet. Add one to offer it in shared workspaces.",
    readyModelDescription: "Ready in shared workspaces",
    waitingModelDescription: "Waiting for an OpenRouter key",
    unavailableModelDescription: "Connection status unavailable",
    modelToastName: "OpenRouter model",
    connectionManagerDescription: "",
  },
};
