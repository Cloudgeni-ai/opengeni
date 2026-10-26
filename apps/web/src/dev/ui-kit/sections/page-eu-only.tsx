import { useState } from "react";
import type { ClientConfig, OrganizationInferenceResidency, Workspace } from "@opengeni/sdk";
import { ModelPolicyPicker, projectPickerRows } from "@opengeni/react";
import { AgentCapabilityPicker } from "@opengeni/react/app/components/agent/agent-capability-picker";
import { VoiceInputPreferences } from "@opengeni/react/app/components/transcription-settings";
import {
  baseCapabilities,
  capabilityAvailability,
  type AgentCapabilityDraft,
} from "@opengeni/react/app/lib/agent-capabilities";
import { t } from "@opengeni/react/app/lib/console-text";
import { Section } from "@opengeni/react/ui/section";
import { InferenceResidencyRow } from "@/components/organization/security-page";
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

/** An in-memory setting: changes apply, as the API would answer a browser admin. */
function residencyClient(initial: OrganizationInferenceResidency) {
  let state = initial;
  return {
    getOrganizationInferenceResidency: async () => state,
    updateOrganizationInferenceResidency: async (
      _organizationId: string,
      request: { euOnly: boolean; expectedVersion: number },
    ) => {
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
}: {
  label: string;
  initial: OrganizationInferenceResidency;
  canTurnOn: boolean;
  subject: string;
}) {
  const [client] = useState(() => residencyClient(initial));
  return (
    <StateCell label={label} align="stretch" span="full">
      <div data-preview={subject} className="w-full">
        <Section title="Data residency">
          <InferenceResidencyRow
            client={client}
            identity={identity(subject)}
            canTurnOn={canTurnOn}
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
      { id: "webSearch", available: false, reason: "Not supported in EU" },
      { id: "media", available: false, reason: "Not supported in EU" },
    ],
  },
  inferenceFeatures: [
    { id: "web_search", available: false, unavailableReason: "region_restricted" },
    { id: "image_generation", available: false, unavailableReason: "region_restricted" },
    { id: "video_generation", available: false, unavailableReason: "region_restricted" },
    { id: "voice_input", available: false, unavailableReason: "region_restricted" },
  ],
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
      </StatesGrid>
    </KitSection>
  );
}
