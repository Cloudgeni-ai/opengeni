import { createRef, useMemo, useState } from "react";
import type { WorkspaceRecordingSettings } from "@opengeni/contracts";
import {
  OpenGeniApiError,
  type ClientConfig,
  type OrganizationInferenceResidency,
  type Workspace,
} from "@opengeni/sdk";
import {
  ChatComposer,
  ModelPolicyPicker,
  projectPickerRows,
  type ComposerState,
} from "@opengeni/react";
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { composerTranscription } from "@opengeni/react/app/components/Composer";
import {
  RealtimeModelPickerMenu,
  RealtimeVoiceControl,
  type RealtimeModelOption,
} from "@opengeni/react/realtime";
import { AgentCapabilityPicker } from "@opengeni/react/app/components/agent/agent-capability-picker";
import { VoiceInputPreferences } from "@opengeni/react/app/components/transcription-settings";
import {
  baseCapabilities,
  capabilityAvailability,
  type AgentCapabilityDraft,
} from "@opengeni/react/app/lib/agent-capabilities";
import { t } from "@opengeni/react/app/lib/console-text";
import {
  createMeetingRecorderStore,
  MeetingDefaultsView,
  MeetingRecorderStoreProvider,
  MeetingsListPage,
} from "@opengeni/react/meetings";
import { createMeetingsFixture } from "@opengeni/react/testing/meetings";
import { Section } from "@opengeni/react/ui/section";
import { InferenceResidencyRow } from "@/components/organization/security-page";
import { VideoGenerationPreferenceRow } from "@/components/video-generation-settings";
import { CodeSearchPreferenceRow } from "@/routes/workspace-settings";
import { galleryModelRows } from "@/dev/composer-chrome-fixtures";
import { KitSection, StateCell, StatesGrid } from "../kit";

/*
 * DEV only. EU-only inference in the production components: the
 * organization setting, the model picker and switched-off features. Sample
 * data stands in for the API: which models are EU here is fixture data, not a
 * residency claim.
 */

const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function residency(euOnly: boolean, canTurnOff: boolean): OrganizationInferenceResidency {
  return {
    organizationId: ORGANIZATION_ID,
    euOnly,
    version: euOnly ? 1 : 0,
    updatedAt: euOnly ? "2026-10-26T12:00:00.000Z" : null,
    canTurnOff,
  };
}

/**
 * An in-memory setting: changes apply, as the API would answer a browser
 * admin. With `needsSignIn`, turning off is refused until "signed in again".
 */
function residencyClient(
  initial: OrganizationInferenceResidency,
  needsSignIn: { current: boolean },
) {
  let state = initial;
  return {
    getOrganizationInferenceResidency: async () => state,
    updateOrganizationInferenceResidency: async (
      _organizationId: string,
      request: { euOnly: boolean; expectedVersion: number },
    ) => {
      if (!request.euOnly && needsSignIn.current) {
        throw new OpenGeniApiError(
          403,
          JSON.stringify({
            code: "forbidden",
            message: "Sign in again to turn EU-only off.",
            details: { code: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" },
          }),
          { mutation: true },
        );
      }
      state = residency(request.euOnly, request.euOnly && initial.canTurnOff);
      state = { ...state, version: request.expectedVersion + 1 };
      return state;
    },
  };
}

function identity(subject: string) {
  return {
    principalGeneration: 1,
    subjectId: `user:${subject}`,
    organizationId: ORGANIZATION_ID,
    workspaceId: WORKSPACE_ID,
  };
}

function ResidencyCell({
  label,
  initial,
  canTurnOn,
  subject,
  needsSignIn = false,
}: {
  label: string;
  initial: OrganizationInferenceResidency;
  canTurnOn: boolean;
  subject: string;
  /** Turning off answers "Sign in again" until the sample sign-in finishes. */
  needsSignIn?: boolean;
}) {
  const [signIn] = useState(() => ({ current: needsSignIn }));
  const [client] = useState(() => residencyClient(initial, signIn));
  return (
    <StateCell label={label} align="stretch" span="full">
      <div data-preview={subject} className="w-full">
        <Section title="Data residency">
          <InferenceResidencyRow
            client={client}
            identity={identity(subject)}
            canTurnOn={canTurnOn}
            signInAgain={(onSignedIn) => {
              // Stands in for the sign-in window.
              window.setTimeout(() => {
                signIn.current = false;
                onSignedIn();
              }, 400);
            }}
          />
        </Section>
      </div>
    </StateCell>
  );
}

/** Sample EU-only catalog: two models have an EU record here, the rest don't. */
const EU_ONLY_MODEL_ROWS = projectPickerRows(
  t,
  galleryModelRows.map(({ catalog }) =>
    catalog.id === "gpt-5.6-sol" || catalog.id === "opper/aws/claude-opus-5-5"
      ? catalog
      : {
          ...catalog,
          availability: {
            status: "unavailable" as const,
            selectable: false,
            reason: "region_restricted" as const,
            checkedAt: null,
          },
        },
  ),
);

/** What the server reports for an EU-only workspace with no EU web search, media or voice route. */
const EU_ONLY_CONFIG = {
  agentConfig: {
    enabled: true,
    defaultForNewSessions: true,
    capabilities: [
      {
        id: "webSearch",
        available: false,
        reason: "Not supported in EU",
        code: "region_restricted",
      },
      { id: "media", available: false, reason: "Not supported in EU", code: "region_restricted" },
    ],
  },
  inferenceFeatures: [
    { id: "web_search", available: false, unavailableReason: "region_restricted" },
    { id: "image_generation", available: false, unavailableReason: "region_restricted" },
    { id: "video_generation", available: false, unavailableReason: "region_restricted" },
    { id: "voice_input", available: false, unavailableReason: "region_restricted" },
    { id: "meeting_transcription", available: false, unavailableReason: "region_restricted" },
    { id: "code_search", available: false, unavailableReason: "region_restricted" },
  ],
  // As the server answers EU-only without an EU decision model.
  codeSearch: { available: false, workspaceDefault: "off" },
  voiceInput: {
    available: false,
    providers: [],
    maxDurationSeconds: 300,
    maxSizeBytes: 26_214_400,
    acceptedMimeTypes: ["audio/webm"],
  },
} as unknown as ClientConfig;

const VOICE_CONTEXT = {
  workspaces: [{ id: WORKSPACE_ID, settings: {} } as unknown as Workspace],
  clientConfig: EU_ONLY_CONFIG,
  captureWorkspaceInvocation: () => null,
  ownsWorkspaceInvocation: () => false,
  updateWorkspaceSettings: async () => null,
};

export default function EuOnlySection() {
  const [model, setModel] = useState("gpt-5.6-sol");
  const [draft, setDraft] = useState<AgentCapabilityDraft>(() => ({
    from: "all",
    values: baseCapabilities("all"),
  }));
  const availability = capabilityAvailability(EU_ONLY_CONFIG.agentConfig);
  return (
    <KitSection sectionKey="page-eu-only">
      <StatesGrid title="Organization setting" columns={1}>
        <ResidencyCell
          label="Off, owner or admin"
          initial={residency(false, false)}
          canTurnOn
          subject="admin-off"
        />
        <ResidencyCell
          label="On, owner or admin who can turn it off"
          initial={residency(true, true)}
          canTurnOn
          subject="admin-on"
        />
        <ResidencyCell
          label="On, turning it off needs a recent sign-in (switch it off)"
          initial={residency(true, true)}
          canTurnOn
          subject="admin-sign-in"
          needsSignIn
        />
        <ResidencyCell
          label="On, can't turn it off (an agent, an API key, or a member)"
          initial={residency(true, false)}
          canTurnOn
          subject="admin-locked"
        />
        <ResidencyCell
          label="Off, member"
          initial={residency(false, false)}
          canTurnOn={false}
          subject="member-off"
        />
      </StatesGrid>
      <StatesGrid title="EU-only workspace" columns={2}>
        <StateCell label="Voice input setting" align="stretch">
          <div data-preview="voice-input" className="w-full">
            <VoiceInputPreferences workspaceId={WORKSPACE_ID} canManage context={VOICE_CONTEXT} />
          </div>
        </StateCell>
        <StateCell label="Agent capabilities" align="stretch" span="full">
          <div data-preview="capabilities" className="w-full">
            <AgentCapabilityPicker draft={draft} onChange={setDraft} availability={availability} />
          </div>
        </StateCell>
        <StateCell label="Model picker (open it)" align="stretch" span="full">
          <div data-preview="model-picker" className="flex min-h-[600px] w-full items-start">
            <ModelPolicyPicker
              rows={EU_ONLY_MODEL_ROWS}
              model={model}
              effort="medium"
              latencyMode="standard"
              menuSide="bottom"
              onModelChange={setModel}
              onEffortChange={() => {}}
              onLatencyModeChange={() => {}}
            />
          </div>
        </StateCell>
        <StateCell label="Meeting settings" align="stretch" span="full">
          <div data-preview="meeting-settings" className="w-full max-w-[720px]">
            <EuOnlyMeetingSettings />
          </div>
        </StateCell>
        <StateCell label="Composer mic" align="stretch" span="full">
          <div data-preview="composer-mic" className="w-full max-w-[720px]">
            <EuOnlyComposer />
          </div>
        </StateCell>
        <StateCell label="Workspace settings: video and code search" align="stretch" span="full">
          <div data-preview="workspace-rows" className="w-full max-w-[720px]">
            <AppContext.Provider value={EU_ONLY_APP_CONTEXT}>
              <Section title="Agents">
                <VideoGenerationPreferenceRow workspaceId={WORKSPACE_ID} canManage refreshKey={0} />
                <CodeSearchPreferenceRow workspaceId={WORKSPACE_ID} canManage />
              </Section>
            </AppContext.Provider>
          </div>
        </StateCell>
        <StateCell label="Meetings" align="stretch" span="full">
          <div data-preview="meetings" className="w-full max-w-[720px]">
            <EuOnlyMeetings />
          </div>
        </StateCell>
        <StateCell label="Live voice" align="stretch" span="full">
          <div data-preview="realtime" className="flex w-full flex-wrap items-start gap-6">
            <EuOnlyRealtime />
          </div>
        </StateCell>
      </StatesGrid>
    </KitSection>
  );
}

/** Meeting settings where the server switched the live model off for the region. */
function EuOnlyMeetingSettings() {
  const fixture = useMemo(() => createMeetingsFixture(), []);
  const recordings = useMemo(
    () => ({
      ...fixture.client,
      listRecordingModels: async (workspaceId: string) => {
        const listed = await fixture.client.listRecordingModels(workspaceId);
        return {
          ...listed,
          models: listed.models.map((entry) =>
            entry.capabilities.live
              ? { ...entry, available: false, unavailableReason: "region_restricted" as const }
              : entry,
          ),
        };
      },
    }),
    [fixture],
  );
  const [settings, setSettings] = useState<WorkspaceRecordingSettings>({ liveTranscript: true });
  return (
    <MeetingDefaultsView
      workspaceId={fixture.workspaceId}
      recordings={recordings}
      settings={settings}
      personal={false}
      canManage
      viewer={{ subjectId: fixture.viewerSubjectId, name: "Ingrid Solberg" }}
      onConnectModels={() => {}}
      onSave={async (next) => {
        setSettings(next);
        return true;
      }}
    />
  );
}

/** Video was on before EU-only; the deployment offers fast code search. */
const EU_ONLY_APP_CONTEXT = {
  client: {
    getVideoGenerationSettings: async () => ({
      schemaVersion: 1,
      policy: { enabledModelIds: ["bytedance/seedance-2.5"], fundingSource: "workspace_gateway" },
      fundingOptions: [
        {
          source: "workspace_gateway",
          label: "AI Gateway",
          description: "This workspace's key",
          available: true,
          unavailableReason: null,
        },
      ],
      availableModels: [],
      capabilities: null,
    }),
  },
  clientConfig: EU_ONLY_CONFIG,
  workspaces: [{ id: WORKSPACE_ID, settings: { codeSearchEnabled: true } }],
  captureWorkspaceInvocation: () => null,
  ownsWorkspaceInvocation: () => false,
  updateWorkspaceSettings: async () => null,
} as unknown as AppContextValue;

function EuOnlyComposer() {
  const [value, setValue] = useState("");
  const composer: ComposerState = {
    value,
    setValue,
    hasDraftContent: () => value.length > 0,
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: value.trim().length > 0,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {},
  };
  return (
    <ChatComposer
      composer={composer}
      placeholder="Ask anything"
      transcription={composerTranscription(EU_ONLY_APP_CONTEXT, WORKSPACE_ID)}
    />
  );
}

/** Meetings where the server switched transcription off for the region. */
function EuOnlyMeetings() {
  const fixture = useMemo(() => createMeetingsFixture(), []);
  const store = useMemo(() => createMeetingRecorderStore(), []);
  return (
    <MeetingRecorderStoreProvider value={store}>
      <MeetingsListPage
        workspaceId={fixture.workspaceId}
        recordings={fixture.client}
        recordingOff={t("inferenceRegion.notSupportedInEu")}
        meetingHref={(id) => `#meeting-${id}`}
        onOpen={() => {}}
      />
    </MeetingRecorderStoreProvider>
  );
}

const EU_ONLY_VOICE_MODEL: RealtimeModelOption = {
  id: "opengeni-gateway/openai/gpt-realtime-2.1",
  label: "GPT Realtime 2.1",
  provider: "OpenGeni",
  description: "Best overall voice intelligence",
  available: false,
  unavailableReason: "Not supported in EU",
  unavailableCode: "region_restricted",
  recommended: true,
};

/** Another voice model with no EU route here. */
const EU_ONLY_VOICE_MODEL_MINI: RealtimeModelOption = {
  id: "opengeni-gateway/openai/gpt-realtime-mini",
  label: "GPT Realtime Mini",
  provider: "OpenGeni",
  description: "Faster, lighter live voice",
  available: false,
  unavailableReason: "Not supported in EU",
  unavailableCode: "region_restricted",
  recommended: false,
};

/**
 * The live voice button and its model list when no voice model has an EU
 * route: shown, switched off.
 */
function EuOnlyRealtime() {
  const noop = async () => {};
  return (
    <>
      <div data-preview="realtime-button">
        <RealtimeVoiceControl
          snapshot={{
            status: "idle",
            realtimeId: null,
            mode: null,
            bridge: null,
            microphone: "inactive",
            inputMuted: false,
            audibleOutput: "inactive",
            outputMuted: false,
            connectionGeneration: 0,
            reconnectAttempt: 0,
            diagnostic: null,
            error: null,
          }}
          canStart={false}
          admissionBlocker="Not supported in EU"
          modelAvailable={false}
          selectedModel={EU_ONLY_VOICE_MODEL}
          models={[EU_ONLY_VOICE_MODEL, EU_ONLY_VOICE_MODEL_MINI]}
          audioRef={createRef<HTMLAudioElement>()}
          onStart={noop}
          onStop={noop}
          onRetry={noop}
          onRetryAudibleOutput={noop}
          onSetInputMuted={() => {}}
          onSetOutputMuted={() => {}}
        />
      </div>
      <div
        data-preview="realtime-picker"
        className="w-[320px] rounded-lg border border-border bg-popover p-1 shadow-md"
      >
        <RealtimeModelPickerMenu
          models={[EU_ONLY_VOICE_MODEL, EU_ONLY_VOICE_MODEL_MINI]}
          selectedModel={EU_ONLY_VOICE_MODEL}
          provider="OpenGeni"
          direction={1}
          disabled={false}
          onProviderChange={() => {}}
          onSelect={() => {}}
        />
      </div>
    </>
  );
}
