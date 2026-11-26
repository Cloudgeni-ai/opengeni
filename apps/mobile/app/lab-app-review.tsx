// Lab (development builds only): the AI-provider permission and Delete account
// screens with example data, for checking how they look without a signed-in
// account or a server. Deep link: opengeni://lab-app-review?state=delete-blocked
import { OpenGeniApiError, type SessionEvent } from "@opengeni/sdk";
import { MessageTimeline, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { createWebMarkdownRenderer } from "@opengeni/react-native/timeline/markdown";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { AccountLabOverride } from "@/account";
import type { AccountDeletionApi, AccountDeletionPreview } from "@/account-deletion";
import { AiConsentLabGate } from "@/ai-consent";
import {
  createAiConsentGate,
  type AiConsentDisclosure,
  type AiConsentStatus,
} from "@/ai-consent-gate";
import { SettingsList } from "@/settings-list";
import { AppThemeProvider } from "@/theme";
import AiProvidersScreen from "./ai-providers";
import { DeleteAccount } from "./delete-account";
import SettingsScreen from "./settings";

const STATES = [
  ["settings", "Settings (organization admin)"],
  ["consent", "Permission before the first Send"],
  ["consent-changed", "Permission: the text changed"],
  ["providers-allowed", "AI providers: allowed"],
  ["providers-not-allowed", "AI providers: not allowed"],
  ["delete-preview", "Delete account"],
  ["delete-blocked", "Delete account: only owner"],
  ["delete-unavailable", "Delete account: unavailable"],
  ["delete-busy", "Delete account: account busy"],
  ["delete-unconfirmed", "Delete account: no answer"],
  ["credit-stop", "Chat: out of credits"],
] as const;
type LabState = (typeof STATES)[number][0];

const providers = ["Anthropic", "Microsoft Azure", "OpenAI"];
const disclosure = (version: string): AiConsentDisclosure => ({
  version,
  title: "Allow sharing with AI providers?",
  body: `To run AI features, Opengeni sends your messages, attached files, tool results, and voice to third-party AI providers: ${providers.join(", ")}. If you or your organization connect your own AI subscription or API key, that provider receives this data too. This data can include personal information. You can withdraw permission at any time in Settings.`,
  providers,
  privacyUrl: "https://opengeni.ai/privacy",
});
const notAllowed = (version = "a".repeat(64)): AiConsentStatus => ({
  required: true,
  disclosure: disclosure(version),
  consent: null,
});
const allowed = (): AiConsentStatus => ({
  required: false,
  disclosure: disclosure("a".repeat(64)),
  consent: { version: "a".repeat(64), grantedAt: "2026-11-26T12:00:00.000Z", platform: "ios" },
});

function labGate(state: LabState) {
  let current = state === "providers-allowed" || state === "settings" ? allowed() : notAllowed();
  let grants = 0;
  return createAiConsentGate({
    read: async () => current,
    grant: async () => {
      grants += 1;
      // The first Allow names text that changed meanwhile, as the server answers then.
      if (state === "consent-changed" && grants === 1) {
        current = notAllowed("b".repeat(64));
        throw new OpenGeniApiError(
          409,
          JSON.stringify({
            error: {
              code: "conflict",
              message: "The disclosure changed.",
              details: { code: "ai_processing_consent_version_mismatch" },
            },
          }),
          { mutation: true },
        );
      }
      current = allowed();
      return current;
    },
    withdraw: async () => {
      current = notAllowed();
      return current;
    },
  });
}

const organizationId = "00000000-0000-4000-8000-000000000001";
const labWorkspace = {
  id: "00000000-0000-4000-8000-000000000002",
  accountId: organizationId,
  kind: "shared" as const,
  name: "Product",
  slug: null,
  externalSource: null,
  externalId: null,
  agentInstructions: null,
  settings: {},
  inferenceControl: {
    state: "active" as const,
    revision: 1,
    reason: null,
    changedBy: null,
    changedAt: null,
  },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const labAccount = {
  id: "lab-account",
  baseUrl: "https://app.opengeni.ai",
  subjectId: "lab-subject",
  email: "alex@example.com",
  workspaceId: labWorkspace.id,
};
const accountPatch = {
  status: "ready" as const,
  account: labAccount,
  accounts: [labAccount],
  workspace: labWorkspace,
  workspaces: [labWorkspace],
  workspaceId: labWorkspace.id,
  organizations: [{ accountId: organizationId, label: "Northwind", canManage: true }],
};

function deletionPreview(state: LabState): AccountDeletionPreview {
  return {
    closeOrganizations: [{ organizationId: "personal", name: "Alex's workspace" }],
    leaveOrganizations: [
      { organizationId: "o-2", name: "Contoso", retention: { mode: "retain", days: null } },
      {
        organizationId: "o-3",
        name: "Fabrikam",
        retention: { mode: "delete_after", days: 30 },
      },
    ],
    blockers:
      state === "delete-blocked"
        ? [{ code: "LAST_ORGANIZATION_OWNER", organizationId, name: "Northwind" }]
        : [],
    request: null,
  };
}

function labDeletion(state: LabState): AccountDeletionApi {
  return {
    read: async () => {
      if (state === "delete-unavailable") {
        throw new OpenGeniApiError(
          503,
          JSON.stringify({
            error: {
              code: "upstream_unavailable",
              message: "Account deletion is not available yet.",
              details: { code: "ACCOUNT_DELETION_UNAVAILABLE" },
            },
          }),
          { mutation: false },
        );
      }
      return deletionPreview(state);
    },
    request: async (operationId) => {
      if (state === "delete-busy") {
        throw new OpenGeniApiError(
          409,
          JSON.stringify({
            error: {
              code: "conflict",
              message: "Your account is busy. Wait a moment and try again.",
              details: { code: "ACCOUNT_DELETION_BUSY" },
            },
          }),
          { mutation: true },
        );
      }
      if (state === "delete-unconfirmed") {
        throw new OpenGeniApiError(0, "", {
          code: "network_error",
          outcomeUnknown: true,
          mutation: true,
        });
      }
      return {
        id: "lab-request",
        operationId,
        status: "pending",
        requestedAt: new Date().toISOString(),
        completedAt: null,
      };
    },
  };
}

function AskOnOpen({ ask }: { ask: () => void }) {
  // Once, shortly after the screen is up.
  const first = useRef(ask);
  useEffect(() => {
    const timer = setTimeout(first.current, 400);
    return () => clearTimeout(timer);
  }, []);
  return null;
}

export default function AppReviewLab() {
  const { state } = useLocalSearchParams<{ state?: LabState }>();
  const gate = useMemo(() => labGate(state ?? "settings"), [state]);
  const deletion = useMemo(() => labDeletion(state ?? "delete-preview"), [state]);
  if (!state || !STATES.some(([id]) => id === state)) return <Menu />;
  if (state === "consent" || state === "consent-changed") {
    return (
      <AiConsentLabGate gate={gate}>
        <Blank />
        <AskOnOpen
          ask={() => {
            void gate.ensure();
            // Allow once, so the server's "the text changed" answer shows.
            if (state === "consent-changed") setTimeout(() => gate.allow(), 300);
          }}
        />
      </AiConsentLabGate>
    );
  }
  if (state === "providers-allowed" || state === "providers-not-allowed") {
    return (
      <AiConsentLabGate gate={gate}>
        <AiProvidersScreen />
      </AiConsentLabGate>
    );
  }
  if (state === "settings") {
    return (
      <AccountLabOverride patch={accountPatch}>
        <AiConsentLabGate gate={gate}>
          <AskOnOpen ask={() => void gate.refresh()} />
          <SettingsScreen />
        </AiConsentLabGate>
      </AccountLabOverride>
    );
  }
  if (state === "credit-stop") return <CreditStop />;
  return (
    <AccountLabOverride patch={accountPatch}>
      <AppThemeProvider>
        <DeleteAccount lab={deletion} />
      </AppThemeProvider>
    </AccountLabOverride>
  );
}

/** A turn the server stopped because the organization ran out of credits. */
function creditStopEvents(): SessionEvent[] {
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 26, 12, 0, seconds)).toISOString();
  const event = (sequence: number, type: string, payload: unknown): SessionEvent =>
    ({
      id: `lab-credit-${sequence}`,
      workspaceId: "lab-workspace",
      sessionId: "lab-credit",
      sequence,
      type,
      payload,
      turnId: "lab-credit-turn",
      occurredAt: at(sequence * 2),
    }) as SessionEvent;
  return [
    event(1, "user.message", { text: "Summarize this week's support tickets." }),
    event(2, "turn.started", {}),
    event(3, "turn.failed", {
      error: "Insufficient Opengeni credits. Add credits to continue.",
      segmentLimit: "budget_exhausted",
    }),
  ];
}

/** The chat as the app draws it, so its purchase-free copy can be checked. */
function CreditStop() {
  const events = useMemo(creditStopEvents, []);
  const renderMarkdown = useMemo(() => createWebMarkdownRenderer({}), []);
  return (
    <AppThemeProvider>
      <Stack.Screen options={{ title: "Support tickets" }} />
      <MessageTimeline events={events} status="idle" renderMarkdown={renderMarkdown} />
    </AppThemeProvider>
  );
}

function Blank() {
  const c = useNativeTimelineTheme().colors;
  return (
    <>
      <Stack.Screen options={{ title: "Opengeni" }} />
      <View style={{ flex: 1, backgroundColor: c.bg }} />
    </>
  );
}

function Menu() {
  return (
    <AppThemeProvider>
      <Stack.Screen options={{ title: "App Review lab" }} />
      <SettingsList
        sections={[
          {
            id: "states",
            rows: STATES.map(([id, title]) => ({
              kind: "navigate" as const,
              id,
              title,
              onPress: () => router.push({ pathname: "/lab-app-review", params: { state: id } }),
            })),
          },
        ]}
      />
    </AppThemeProvider>
  );
}
