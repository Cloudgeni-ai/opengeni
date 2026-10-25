import { deploymentAzureEntraCredential, type Settings } from "@opengeni/config";
import {
  AzureEntraTokenError,
  createAzureEntraAccessTokenSource,
  sharedAzureEntraAccessTokenSource,
} from "@opengeni/network/azure-entra";
import {
  AZURE_SPEECH_PROVIDER_ID,
  createAzureSpeechRecordingTranscriptionProvider,
} from "./recording-transcription-azure";
import {
  createElevenLabsRecordingTranscriptionProvider,
  createRecordingTranscriptionProviderRegistry,
  DEFAULT_RECORDING_TRANSCRIPTION,
  RecordingTranscriptionError,
  type RecordingTranscriptionCredentials,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionProviderRegistry,
} from "./recording-transcription";

/**
 * The transcription providers a deployment offers recordings. Some use a
 * workspace's or organization's own key (ElevenLabs); others are accounts the
 * deployment itself holds (Azure Speech), whose credentials come from here.
 */
export type RecordingTranscriptionDeployment = {
  registry: RecordingTranscriptionProviderRegistry;
  /** The model recordings use unless a workspace or request picks another. */
  defaultTranscription: { providerId: string; model: string };
  /** Whether the deployment itself holds this provider's credential. */
  deploymentManaged(providerId: string): boolean;
  /**
   * The deployment's credential for a provider it manages, or null for
   * providers that use workspace keys.
   */
  deploymentCredentials(providerId: string): Promise<RecordingTranscriptionCredentials> | null;
};

export function createRecordingTranscriptionDeployment(
  settings: Pick<
    Settings,
    | "recordingAzureSpeechEndpoint"
    | "recordingAzureSpeechApiKey"
    | "recordingTranscriptionDefault"
    | "azureTenantId"
    | "azureClientId"
    | "azureFederatedTokenFile"
    | "azureClientSecret"
    | "azureAuthorityHost"
  >,
  options: {
    fetch?: typeof fetch;
    readTokenFile?: (path: string) => Promise<string>;
    /** Extra or replacement providers, such as fakes in tests. */
    providers?: readonly RecordingTranscriptionProvider[];
  } = {},
): RecordingTranscriptionDeployment {
  const providers: RecordingTranscriptionProvider[] = [
    createElevenLabsRecordingTranscriptionProvider(options.fetch ? { fetch: options.fetch } : {}),
  ];
  const managed = new Map<string, () => Promise<RecordingTranscriptionCredentials>>();
  const endpoint = settings.recordingAzureSpeechEndpoint;
  if (endpoint) {
    providers.push(
      createAzureSpeechRecordingTranscriptionProvider({
        endpoint,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    );
    const apiKey = settings.recordingAzureSpeechApiKey;
    if (apiKey) {
      managed.set(AZURE_SPEECH_PROVIDER_ID, async () => ({ apiKey }));
    } else {
      const identity = deploymentAzureEntraCredential(settings);
      if (identity) {
        // The deployment's one identity, shared with every other Azure AI
        // service it calls, so they share its tokens. Tests inject their own.
        const token =
          options.fetch || options.readTokenFile
            ? createAzureEntraAccessTokenSource(identity, {
                ...(options.fetch ? { fetch: options.fetch } : {}),
                ...(options.readTokenFile ? { readTokenFile: options.readTokenFile } : {}),
              })
            : sharedAzureEntraAccessTokenSource(identity);
        managed.set(AZURE_SPEECH_PROVIDER_ID, async () => {
          try {
            return { accessToken: await token() };
          } catch (error) {
            if (!(error instanceof AzureEntraTokenError)) throw error;
            throw new RecordingTranscriptionError(
              error.message,
              error.reason === "network"
                ? "network"
                : error.reason === "unavailable"
                  ? "unavailable"
                  : "unauthorized",
              error.retryable,
            );
          }
        });
      }
    }
  }
  for (const provider of options.providers ?? []) {
    const index = providers.findIndex((existing) => existing.id === provider.id);
    if (index >= 0) providers[index] = provider;
    else providers.push(provider);
  }
  const registry = createRecordingTranscriptionProviderRegistry(providers);
  const [defaultProvider, defaultModel] = settings.recordingTranscriptionDefault?.split("/") ?? [];
  const defaultTranscription =
    defaultProvider && defaultModel
      ? { providerId: defaultProvider, model: defaultModel }
      : endpoint
        ? { providerId: AZURE_SPEECH_PROVIDER_ID, model: "MAI-Transcribe-2" }
        : DEFAULT_RECORDING_TRANSCRIPTION;
  return {
    registry,
    defaultTranscription,
    deploymentManaged: (providerId) => managed.has(providerId),
    deploymentCredentials: (providerId) => managed.get(providerId)?.() ?? null,
  };
}
