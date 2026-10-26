import {
  deploymentAzureEntraCredential,
  resolveVoiceInputProviderRegistry,
  type Settings,
} from "@opengeni/config";
import {
  getWorkspace,
  getWorkspaceProviderApiKeyConnectionMetadata,
  loadOrganizationModelProviderApiKey,
  loadWorkspaceProviderApiKey,
  organizationModelProviderConnectionActiveForWorkspace,
  type Database,
} from "@opengeni/db";
import {
  AzureEntraTokenError,
  createAzureEntraAccessTokenSource,
  sharedAzureEntraAccessTokenSource,
} from "@opengeni/network/azure-entra";
import {
  AZURE_SPEECH_PROVIDER_ID,
  createAzureSpeechRecordingTranscriptionProvider,
} from "../recording-transcription-azure";
import {
  createElevenLabsRecordingTranscriptionProvider,
  createRecordingTranscriptionProviderRegistry,
  DEFAULT_RECORDING_TRANSCRIPTION,
  findRecordingTranscriptionModel,
  RecordingTranscriptionError,
  type RecordingTranscriptionCredentials,
  type RecordingTranscriptionModelSpec,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionProviderRegistry,
} from "../recording-transcription";
import { createAzureOpenAiTranscriptionProvider } from "./providers/azure-openai";
import { createCodexSubscriptionTranscriptionProvider } from "./providers/codex-subscription";
import { createOpenAiTranscriptionProvider } from "./providers/openai";
import { createXaiSubscriptionTranscriptionProvider } from "./providers/xai-subscription";

/** What a transcription is for. Each use has its own default model. */
export type SpeechToTextUse = "meeting" | "dictation";

export type SpeechToTextModelRef = { providerId: string; model: string };

/**
 * Every speech-to-text provider a deployment offers, for every use: the
 * models, who pays for each, the defaults and where each call's credential
 * comes from. The API and the worker both build it from settings.
 */
export type SpeechToTextDeployment = {
  registry: RecordingTranscriptionProviderRegistry;
  /**
   * The provider ids in the deployment's order, which dictation tries in
   * turn when the workspace names none (OPENGENI_VOICE_INPUT_PROVIDER_ORDER,
   * then the recording providers).
   */
  order: readonly string[];
  /** One model for every use; workspaces cannot pick another. */
  pinned: SpeechToTextModelRef | null;
  /** The model new meeting transcripts use when a workspace names none. */
  meetingDefault: SpeechToTextModelRef;
  /**
   * Whether the deployment places a text-only model's words on the audio
   * itself, so every model can serve meetings, not only those that time
   * their words.
   */
  wordAlignment: boolean;
  /**
   * The credential a call to this provider carries: the workspace's or its
   * organization's key for key providers, null for providers that hold or
   * resolve their own (deployment accounts, subscriptions). `missing` when a
   * key provider has no key for this workspace.
   */
  credentials(
    providerId: string,
    scope: { accountId: string; workspaceId: string },
  ): Promise<{ credentials: RecordingTranscriptionCredentials | null } | "missing">;
  /**
   * Whether the provider can serve this workspace now. Without a workspace,
   * whether the deployment offers it at all.
   */
  available(
    providerId: string,
    scope?: { accountId?: string; workspaceId: string; subjectId?: string },
  ): Promise<boolean>;
};

export type SpeechToTextDeploymentOptions = {
  fetch?: typeof fetch;
  codexFetch?: typeof fetch;
  readTokenFile?: (path: string) => Promise<string>;
  /** Test seam for the Codex subscription's readiness probe. */
  probeCodex?: (scope?: {
    accountId?: string;
    workspaceId?: string;
    subjectId?: string;
  }) => boolean | Promise<boolean>;
  /** Extra or replacement providers, such as fakes in tests. */
  providers?: readonly RecordingTranscriptionProvider[];
  /** Test seam: a workspace key lookup that needs no database. */
  loadWorkspaceKey?: (
    providerId: string,
    scope: { accountId: string; workspaceId: string },
  ) => Promise<string | null>;
};

/** Providers that run on the workspace's or organization's own key, by connection kind. */
const KEY_PROVIDER_CONNECTIONS: Record<string, "elevenlabs"> = { elevenlabs: "elevenlabs" };

export function createSpeechToTextDeployment(
  input: { settings: Settings; db?: Database | undefined },
  options: SpeechToTextDeploymentOptions = {},
): SpeechToTextDeployment {
  const { settings, db } = input;
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  const providers: RecordingTranscriptionProvider[] = [];
  const order: string[] = [];
  const add = (provider: RecordingTranscriptionProvider) => {
    if (providers.some((existing) => existing.id === provider.id)) return;
    providers.push(provider);
    order.push(provider.id);
  };
  const azure = azureSpeechAccount(settings, options);
  const elevenLabs = createElevenLabsRecordingTranscriptionProvider(fetchOption);
  const voiceConfigs = resolveVoiceInputProviderRegistry(settings);
  // The order may name the recording providers too; they keep that place.
  const named = settings.voiceInputProviderOrder.split(",").map((part) => part.trim());
  const position = (id: string) => {
    const index = named.indexOf(id);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  const azurePosition = Math.min(position("azure-speech"), position("azure-mai"));
  const elevenLabsPosition = position("elevenlabs");
  const placeNamedRecordingProviders = (before: number) => {
    if (azure && azurePosition < before) add(azure);
    if (elevenLabsPosition < before) add(elevenLabs);
  };
  for (const config of voiceConfigs) {
    placeNamedRecordingProviders(config.kind === "azure-mai" ? azurePosition : position(config.id));
    switch (config.kind) {
      case "openai":
        add(createOpenAiTranscriptionProvider({ ...config, ...fetchOption }));
        break;
      case "azure-openai":
        add(createAzureOpenAiTranscriptionProvider({ ...config, ...fetchOption }));
        break;
      case "azure-mai":
        // The voice input's MAI account and the recordings' Speech account
        // are one provider; the recordings' account wins when both are set.
        add(
          azure ??
            createAzureSpeechRecordingTranscriptionProvider({
              endpoint: config.endpoint,
              apiVersion: config.apiVersion,
              creditPricing: config.pricing ?? null,
              credentials: async () => ({ apiKey: config.apiKey }),
              ...fetchOption,
            }),
        );
        break;
      case "codex-subscription":
        if (!db) break;
        add(
          createCodexSubscriptionTranscriptionProvider({
            settings,
            db,
            ...(options.codexFetch ? { fetch: options.codexFetch } : {}),
            ...(options.probeCodex ? { probe: options.probeCodex } : {}),
          }),
        );
        break;
      case "supergrok-subscription":
        if (!db) break;
        add(createXaiSubscriptionTranscriptionProvider({ settings, db, ...fetchOption }));
        break;
    }
  }
  const recordingProviders: [number, RecordingTranscriptionProvider | null][] = [
    [azurePosition, azure],
    [elevenLabsPosition, elevenLabs],
  ];
  for (const [, provider] of recordingProviders.sort((a, b) => (a[0] === b[0] ? 0 : a[0] - b[0]))) {
    if (provider) add(provider);
  }
  for (const provider of options.providers ?? []) {
    const index = providers.findIndex((existing) => existing.id === provider.id);
    if (index >= 0) providers[index] = provider;
    else {
      providers.push(provider);
      order.push(provider.id);
    }
  }
  const registry = createRecordingTranscriptionProviderRegistry(providers);
  const pinned = modelRef(settings.speechToTextPinned);
  const configuredDefault = modelRef(settings.recordingTranscriptionDefault);
  const meetingDefault =
    pinned ??
    configuredDefault ??
    (registry.has(AZURE_SPEECH_PROVIDER_ID)
      ? { providerId: AZURE_SPEECH_PROVIDER_ID, model: "MAI-Transcribe-2" }
      : DEFAULT_RECORDING_TRANSCRIPTION);
  if (pinned && !findRecordingTranscriptionModel(registry, pinned.providerId, pinned.model)) {
    throw new Error(
      `OPENGENI_SPEECH_TO_TEXT_PINNED names ${pinned.providerId}/${pinned.model}, which this deployment does not offer`,
    );
  }
  const loadWorkspaceKey =
    options.loadWorkspaceKey ??
    (async (providerId: string, scope: { accountId: string; workspaceId: string }) => {
      const kind = KEY_PROVIDER_CONNECTIONS[providerId];
      if (!kind || !db) return null;
      return (
        (await loadWorkspaceProviderApiKey(db, settings, scope.workspaceId, kind)) ??
        (await loadOrganizationModelProviderApiKey(db, settings, {
          ...scope,
          providerKind: kind,
        }))
      );
    });
  return {
    registry,
    order,
    pinned,
    meetingDefault,
    wordAlignment: settings.recordingWordAlignment,
    async credentials(providerId, scope) {
      const provider = registry.get(providerId);
      if (!provider) return "missing";
      if (provider.funding !== "workspace_key") return { credentials: null };
      const apiKey = await loadWorkspaceKey(providerId, scope);
      return apiKey ? { credentials: { apiKey } } : "missing";
    },
    async available(providerId, scope) {
      const provider = registry.get(providerId);
      if (!provider) return false;
      try {
        if (provider.funding === "workspace_key") {
          if (!scope) return true;
          const kind = KEY_PROVIDER_CONNECTIONS[providerId];
          if (options.loadWorkspaceKey || !kind || !db) {
            const accountId = scope.accountId;
            return accountId
              ? (await loadWorkspaceKey(providerId, {
                  accountId,
                  workspaceId: scope.workspaceId,
                })) !== null
              : false;
          }
          // A caller without the account still finds the organization's key.
          const accountId =
            scope.accountId ?? (await getWorkspace(db, scope.workspaceId))?.accountId;
          const [own, organization] = await Promise.all([
            getWorkspaceProviderApiKeyConnectionMetadata(db, scope.workspaceId, kind),
            accountId
              ? organizationModelProviderConnectionActiveForWorkspace(db, {
                  accountId,
                  workspaceId: scope.workspaceId,
                  providerKind: kind,
                })
              : Promise.resolve(false),
          ]);
          return own !== null || organization;
        }
        return provider.available ? await provider.available(scope) : true;
      } catch {
        // A failing readiness probe means the provider is not ready; it
        // never fails the caller.
        return false;
      }
    },
  };
}

/** The recordings' Azure Speech account, signed in with its key or Microsoft Entra ID. */
function azureSpeechAccount(
  settings: Settings,
  options: SpeechToTextDeploymentOptions,
): RecordingTranscriptionProvider | null {
  const endpoint = settings.recordingAzureSpeechEndpoint;
  if (!endpoint) return null;
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  const apiKey = settings.recordingAzureSpeechApiKey;
  let credentials: (() => Promise<RecordingTranscriptionCredentials>) | null = null;
  if (apiKey) {
    credentials = async () => ({ apiKey });
  } else {
    const identity = deploymentAzureEntraCredential(settings);
    if (identity) {
      // The deployment's one identity, shared with every other Azure AI
      // service it calls, so they share its tokens. Tests inject their own.
      const token =
        options.fetch || options.readTokenFile
          ? createAzureEntraAccessTokenSource(identity, {
              ...fetchOption,
              ...(options.readTokenFile ? { readTokenFile: options.readTokenFile } : {}),
            })
          : sharedAzureEntraAccessTokenSource(identity);
      credentials = async () => {
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
      };
    }
  }
  if (!credentials) return null;
  // A voice input MAI price, where set, prices this account's calls in credits.
  const voiceMai = resolveVoiceInputProviderRegistry(settings).find(
    (config) => config.kind === "azure-mai",
  );
  return createAzureSpeechRecordingTranscriptionProvider({
    endpoint,
    credentials,
    creditPricing: voiceMai?.kind === "azure-mai" ? (voiceMai.pricing ?? null) : null,
    ...fetchOption,
  });
}

/**
 * Whether a model can transcribe meetings here: a meeting places every word
 * in time, which the model does itself or, when the deployment aligns words,
 * the worker does from the model's text.
 */
export function speechToTextServesMeetings(
  deployment: Pick<SpeechToTextDeployment, "wordAlignment">,
  spec: Pick<RecordingTranscriptionModelSpec, "capabilities">,
): boolean {
  return spec.capabilities.wordTimestamps || deployment.wordAlignment;
}

function modelRef(value: string | undefined | null): SpeechToTextModelRef | null {
  const [providerId, model] = value?.split("/") ?? [];
  return providerId && model ? { providerId, model } : null;
}

/**
 * The model a use runs: the deployment's pin, else what the request or the
 * workspace names, else the use's default (null for dictation, which then
 * tries the deployment's providers in order).
 */
export function speechToTextModelFor(
  deployment: SpeechToTextDeployment,
  use: SpeechToTextUse,
  named: SpeechToTextModelRef | null | undefined,
): SpeechToTextModelRef | null {
  if (deployment.pinned) return deployment.pinned;
  if (named) return named;
  return use === "meeting" ? deployment.meetingDefault : null;
}

/**
 * The model a workspace's meeting runs: the deployment's pin, else what the
 * request or the workspace names, else the deployment's meeting default when
 * this workspace can use it, else the first model in the deployment's order
 * that serves meetings and that this workspace can use. A workspace signed in
 * to a subscription, or holding its own key, transcribes with it without
 * picking it first. When none is usable it is still the default, so the
 * failure names the provider to connect.
 */
export async function meetingModelFor(
  deployment: SpeechToTextDeployment,
  named: SpeechToTextModelRef | null | undefined,
  scope: { accountId?: string; workspaceId: string; subjectId?: string },
): Promise<SpeechToTextModelRef> {
  if (deployment.pinned) return deployment.pinned;
  if (named) return named;
  const fallback = deployment.meetingDefault;
  const candidates: SpeechToTextModelRef[] = [fallback];
  for (const providerId of deployment.order) {
    const provider = deployment.registry.get(providerId);
    const spec = provider?.models.find(
      (candidate) =>
        candidate.capabilities.batch && speechToTextServesMeetings(deployment, candidate),
    );
    if (spec) candidates.push({ providerId, model: spec.model });
  }
  const checked = new Map<string, Promise<boolean>>();
  for (const candidate of candidates) {
    if (
      !findRecordingTranscriptionModel(deployment.registry, candidate.providerId, candidate.model)
    ) {
      continue;
    }
    let available = checked.get(candidate.providerId);
    if (!available) {
      available = deployment.available(candidate.providerId, scope).catch(() => false);
      checked.set(candidate.providerId, available);
    }
    if (await available) return candidate;
  }
  return fallback;
}
