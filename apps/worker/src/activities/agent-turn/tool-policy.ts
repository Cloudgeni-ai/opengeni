import {
  desktopCapableBackend,
  type ComputerToolMode,
  type LazyToolTransport,
} from "@opengeni/runtime";
import {
  isDirectOpenAiApiBaseUrl,
  type ModelProviderApi,
  type ResolvedModelProvider,
  type Settings,
} from "@opengeni/config";
import { type ModelAttachmentInputPolicy } from "../run-input";
import { imageProviderBindingHash } from "../image-generation-operation";

export function shouldStartOnTurnRecording(params: {
  recordingEnabled: boolean;
  desktopEnabled: boolean;
  establishedBackendId: string;
  effectiveBackend: Settings["sandboxBackend"] | undefined;
}): boolean {
  return (
    params.recordingEnabled &&
    params.desktopEnabled &&
    desktopCapableBackend(params.establishedBackendId) &&
    params.effectiveBackend !== "selfhosted"
  );
}

/**
 * Decide the EXPLICIT computer-use tool transport for THIS turn.
 *
 * Computer-use is ordinary `computer_*` function tools bound to the live
 * desktop. The worker picks the mode from the resolved provider so the runtime
 * never string-sniffs the model instance:
 *   • catalogue `inputModalities` must include `image`, or computer-use is off
 *   • Responses wires (Azure/OpenAI, Gateway, Codex, legacy client) →
 *     "function-image": screenshot results are structured `{type:'image'}`
 *   • Chat Completions → "disabled": tool results on that wire are text, so a
 *     screenshot would become a base64 string rather than an image the model sees
 *
 * Pure + exported so the mapping is unit-testable without a live turn.
 */
export function computerToolModeForTurn(
  resolvedModel: {
    provider: { kind: ResolvedModelProvider["kind"]; api: ModelProviderApi };
    configured: { capabilities: { inputModalities: string[] } };
  } | null,
): ComputerToolMode {
  if (!resolvedModel) {
    return "function-image";
  }
  if (!modelSupportsImageInputForTurn(resolvedModel)) {
    return "disabled";
  }
  if (resolvedModel.provider.kind === "codex-subscription") {
    return "function-image";
  }
  if (resolvedModel.provider.api === "chat") {
    return "disabled";
  }
  return "function-image";
}

/** Chat wires and Gateway models do not advertise OpenAI's hosted sandbox tool types. */
export function structuredToolTransportForTurn(
  resolvedModel: {
    provider: { kind: ResolvedModelProvider["kind"]; api: ModelProviderApi };
  } | null,
): boolean {
  if (!resolvedModel) return true;
  if (resolvedModel.provider.api === "chat") return false;
  return ![
    "codex-subscription",
    "xai-subscription",
    "vercel-gateway-managed",
    "vercel-gateway-workspace",
  ].includes(resolvedModel.provider.kind);
}

/**
 * Progressive tool disclosure is universal for supported OpenGeni turns; only
 * its contained transport differs. Codex keeps its native path, built-in direct
 * OpenAI/Azure Responses use native client tool search, and every other ordinary
 * function-calling provider uses OpenGeni's stable search/invoke dispatcher.
 */
export function lazyToolTransportForTurn(
  resolvedModel: {
    provider: {
      id: string;
      kind: ResolvedModelProvider["kind"];
      api: ModelProviderApi;
      wireProfile: "openai" | "azure-openai";
      builtin: boolean;
      baseUrl?: string | undefined;
    };
  } | null,
): LazyToolTransport {
  if (!resolvedModel) return "openai_native";
  const provider = resolvedModel.provider;
  if (provider.kind === "codex-subscription") return "codex_native";
  const isNativeResponsesProvider =
    provider.api === "responses" &&
    (provider.wireProfile === "azure-openai" ||
      (provider.builtin && provider.id === "openai" && provider.baseUrl === undefined));
  if (isNativeResponsesProvider) {
    return "openai_native";
  }
  return "generic_dispatch";
}

/** Only brand-new lazy-capable turns may overlap non-eager tool preparation. */
export function shouldDeferNonEagerToolPreparation(args: {
  lazyToolTransport: LazyToolTransport | null;
  progressiveDisclosureEnabled: boolean;
  /** Retained for call-site compatibility; the lazy runtime now gates artifact
   * and ordinary function calls on the same exact preparation promise. */
  artifactRuntimeAvailable: boolean;
  triggerKind: "next" | "approval";
  triggerType: string;
}): boolean {
  return Boolean(
    args.lazyToolTransport &&
    args.progressiveDisclosureEnabled &&
    args.triggerKind === "next" &&
    (args.triggerType === "user.message" || args.triggerType === "system.update.delivered"),
  );
}

/**
 * Native web search is a runtime capability, not part of the session's MCP
 * allow-list. Attach it whenever the resolved provider advertises runnable
 * support. The null model is the legacy built-in Responses path, whose
 * deployment flag is its provider capability gate. There is deliberately no
 * cross-provider or sandbox/curl fallback.
 */
export function hostedWebSearchForTurn(
  resolvedModel: { configured: { hostedWebSearch: boolean } } | null,
  deploymentWebSearchEnabled: boolean,
): boolean {
  return resolvedModel?.configured.hostedWebSearch ?? deploymentWebSearchEnabled;
}

/**
 * Image generation is an optional connected-account capability. A delegated
 * subscription may still authorize the text model without carrying the local
 * credential identity required for paid image operations; that must narrow the
 * tool catalog, not reject an otherwise valid turn.
 */
export function connectedSubscriptionImageGenerationAuthority<T>(
  credentialContext: T | null | undefined,
  credentialId: string | null | undefined,
): { credentialContext: T; credentialId: string } | null {
  if (credentialContext == null || typeof credentialId !== "string" || credentialId.length === 0)
    return null;
  return { credentialContext, credentialId };
}

/** Direct OpenAI hosted image IDs are reusable only by the exact API credential. */
export function openAiHostedImageProviderBindingForTurn(
  settings: Pick<Settings, "openaiProvider" | "openaiApiKey" | "openaiBaseUrl">,
  resolvedModel: {
    provider: {
      id: string;
      kind: ResolvedModelProvider["kind"];
      builtin: boolean;
      baseUrl?: string | undefined;
    };
    configured: {
      capabilities: {
        hostedTools: { imageGeneration: { runnable: boolean } };
      };
    };
  } | null,
): { providerId: string; providerBindingHash: string } | null {
  if (!resolvedModel?.configured.capabilities.hostedTools.imageGeneration.runnable) return null;
  const providerId = resolvedModel.provider.id;
  const isDirectOpenAi =
    resolvedModel.provider.builtin &&
    resolvedModel.provider.id === "openai" &&
    isDirectOpenAiApiBaseUrl(resolvedModel.provider.baseUrl) &&
    settings.openaiProvider === "openai" &&
    isDirectOpenAiApiBaseUrl(settings.openaiBaseUrl);
  const bindingIdentity = isDirectOpenAi ? settings.openaiApiKey : null;
  if (!bindingIdentity) return null;
  return {
    providerId,
    providerBindingHash: imageProviderBindingHash(providerId, bindingIdentity),
  };
}

/** Exact model-catalog modality gate; null preserves the legacy built-in path. */
export function modelSupportsImageInputForTurn(
  resolvedModel: {
    configured: { capabilities?: { inputModalities: string[] } };
  } | null,
): boolean {
  return (
    resolvedModel === null ||
    resolvedModel.configured.capabilities?.inputModalities.includes("image") !== false
  );
}

/** Image support is catalogue-driven; document bytes are never `input_file`. */
export function modelAttachmentInputPolicyForTurn(
  resolvedModel: {
    provider: { api: ModelProviderApi };
    configured: {
      capabilities?: {
        inputModalities: string[];
        inputFileMediaTypes?: string[];
      };
    };
  } | null,
): ModelAttachmentInputPolicy {
  const typedTransport = resolvedModel === null || resolvedModel.provider.api === "responses";
  return {
    supportsImageInput: typedTransport && modelSupportsImageInputForTurn(resolvedModel),
    inputFileMediaTypes: [],
  };
}
