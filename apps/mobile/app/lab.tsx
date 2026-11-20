// Reference lab: the deterministic web fixture scenarios through the native
// MessageTimeline, for side-by-side comparison with the web harness
// (/dev/session-timeline). Deep link: opengeni://lab?scenario=working&scheme=dark&chrome=0
import { labScenarios, type LabScenarioId } from "@opengeni/react/testing";
import { useOpenGeniText } from "@opengeni/react/messages";
import { InteractiveAnswerProvider } from "@opengeni/react/interactive-answer-model";
import {
  AnnotationsChip,
  AnnotationsSheet,
  HumanInputCard,
  MessageTimeline,
  useNativeInChatConnect,
  useNativeTimelineTheme,
  type AnnotationReveal,
} from "@opengeni/react-native/timeline";
import {
  personalMachineUseIntent,
  type MachineMoveChat,
} from "@opengeni/react/machine-request-model";
import { buildTimeline } from "@opengeni/react/session";
import type {
  ChatClient,
  DraftTimelineAnnotation,
  MachineView,
  SessionEvent,
  SessionHumanInputRequest,
} from "@opengeni/sdk";
import { createWebMarkdownRenderer } from "@opengeni/react-native/timeline/markdown";
import { createNativePreviewRenderers } from "@opengeni/react-native/timeline/previews";
import { useAccount } from "@/account";
import { copyText } from "@/clipboard";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppThemeProvider } from "@/theme";

type Params = { scenario?: LabScenarioId; scheme?: "light" | "dark"; chrome?: string };

const labSend = async () => true;

/** A private chat that can take a Send, with the owner's machine consent. */
const labChat = (): MachineMoveChat => ({
  blocked: null,
  awaitingHuman: false,
  personalMachineIntent: personalMachineUseIntent(
    { visibility: "private", authorityEpoch: 1 },
    "always",
  ),
  extras: {},
});

/** Questions an agent is waiting on in the scenario, as the session reads them. */
function pendingQuestions(events: readonly SessionEvent[]): SessionHumanInputRequest[] {
  const answered = new Set(
    events
      .filter((event) => event.type === "session.humanInput.resolved")
      .map((event) => (event.payload as { requestId?: string }).requestId),
  );
  return events.flatMap((event) => {
    if (event.type !== "session.humanInput.requested") return [];
    const request = (event.payload as { request: Partial<SessionHumanInputRequest> }).request;
    if (!request.id || answered.has(request.id)) return [];
    return [
      {
        workspaceId: event.workspaceId,
        sessionId: event.sessionId,
        turnId: event.turnId ?? "",
        turnGeneration: 1,
        creationAttemptId: "lab",
        toolCallId: `${request.id}-call`,
        status: "pending",
        response: null,
        respondedBy: null,
        respondedAt: null,
        expiresAt: null,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        allowSkip: false,
        questions: [],
        ...request,
      } as SessionHumanInputRequest,
    ];
  });
}

const labMachine = (overrides: Partial<MachineView>): MachineView =>
  ({
    enrollmentId: `enrollment-${overrides.sandboxId}`,
    scope: "user",
    generation: 1,
    kind: "selfhosted",
    state: "online",
    active: false,
    isSessionGroup: false,
    workspaceGeneration: null,
    archiveGeneration: null,
    archiveComplete: false,
    os: "linux",
    arch: "x64",
    hasDisplay: false,
    allowScreenControl: false,
    sharedSessionCount: 0,
    lastSeenAt: null,
    runtime: null,
    operationPolicy: null,
    metrics: null,
    ...overrides,
  }) as MachineView;

/**
 * The calls a conversation's cards make, answered in memory: the person's
 * grant and catalog, and their machines (one the agent asked for, one off),
 * so the lab shows each card as a person would meet it.
 */
function createLabClient(): ChatClient {
  let machines: MachineView[] = [
    labMachine({ sandboxId: "lab-machine-server", name: "Build server" }),
    labMachine({
      sandboxId: "lab-machine-laptop",
      name: "Studio MacBook",
      state: "offline",
      hasDisplay: true,
      os: "darwin",
      arch: "arm64",
    }),
  ];
  const client = {
    getClientConfig: async () => ({ chatConnections: true }),
    getAccessContext: async () => ({
      workspaceGrants: [
        {
          workspaceId: "lab-workspace",
          permissions: [
            "sessions:read",
            "sessions:control",
            "connections:write",
            "enrollments:read",
          ],
        },
      ],
    }),
    listCapabilities: async () => ({ items: [] }),
    listMachines: async () => ({
      activeSandboxId: machines.find((machine) => machine.active)?.sandboxId ?? null,
      activeEpoch: 1,
      machines,
    }),
    swapActiveSandbox: async (
      _workspaceId: string,
      _sessionId: string,
      request: { target: string },
    ) => {
      machines = machines.map((machine) => ({
        ...machine,
        active: machine.sandboxId === request.target,
      }));
      return { swapped: true, activeSandboxId: request.target, activeEpoch: 2 };
    },
    sendMessage: async () => ({ payload: { routing: "started" } }),
  };
  return client as unknown as ChatClient;
}

export default function ReferenceLab() {
  const params = useLocalSearchParams<Params>();
  const scheme = params.scheme ?? "light";
  return (
    <AppThemeProvider scheme={scheme}>
      <LabBody params={params} scheme={scheme} />
    </AppThemeProvider>
  );
}

function LabBody({ params, scheme }: { params: Params; scheme: "light" | "dark" }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const insets = useSafeAreaInsets();
  const scenarios = useMemo(() => labScenarios(), []);
  const { client, workspaceId } = useAccount();
  // Fixture previews and plain image URLs need no workspace; retained files use the account's.
  const renderMarkdown = useMemo(
    () =>
      createWebMarkdownRenderer({
        onCopy: (text) => void copyText(text),
        ...createNativePreviewRenderers(t, { client, workspaceId: workspaceId ?? "lab-workspace" }),
      }),
    [client, workspaceId, t],
  );
  const scenarioId = params.scenario ?? "working";
  const scenario = scenarios.find((entry) => entry.id === scenarioId) ?? scenarios[0]!;
  // One in-memory client for the lab's cards; reopen the lab to start over.
  const [labClient] = useState(createLabClient);
  const items = useMemo(() => buildTimeline(t, scenario.events), [t, scenario.events]);
  const renderAuthNeeded = useNativeInChatConnect({
    client: labClient,
    workspaceId: "lab-workspace",
    sessionId: scenario.events[0]?.sessionId ?? "lab",
    items,
    options: {
      browser: { openAuthSession: async () => undefined },
      returnUrl: "https://example.com/connected",
      shareConversation: () => undefined,
    },
    chat: labChat,
  });
  const questions = useMemo(() => pendingQuestions(scenario.events), [scenario.events]);
  const showChrome = params.chrome !== "0";
  // Add note on selected text, held locally: the composer's draft annotations.
  const [annotations, setAnnotations] = useState<DraftTimelineAnnotation[]>([]);
  const [review, setReview] = useState<{ open: boolean; focusId: string | null }>({
    open: false,
    focusId: null,
  });
  const reveal = useRef<AnnotationReveal | null>(null);
  const addAnnotation = useCallback((annotation: DraftTimelineAnnotation) => {
    setAnnotations((current) => [...current, annotation]);
    setReview({ open: true, focusId: annotation.id });
  }, []);
  const selectAnnotation = useCallback((id: string) => setReview({ open: true, focusId: id }), []);
  const set = (next: Partial<Params>) =>
    router.setParams({ scenario: scenarioId, scheme, chrome: params.chrome ?? "1", ...next });
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {showChrome ? (
        <View
          style={{
            gap: 6,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Segments
            options={scenarios.map((entry) => ({ id: entry.id, label: entry.title }))}
            selected={scenarioId}
            onSelect={(id) => set({ scenario: id as LabScenarioId })}
          />
          <Segments
            options={[
              { id: "light", label: "Light" },
              { id: "dark", label: "Dark" },
            ]}
            selected={scheme}
            onSelect={(id) => set({ scheme: id as "light" | "dark" })}
          />
        </View>
      ) : null}
      {/* Picks in interactive answers "send" without leaving the lab. */}
      <InteractiveAnswerProvider send={labSend} scope={`lab-${scenario.id}`}>
        <MessageTimeline
          key={scenario.id}
          events={scenario.events}
          status={scenario.running ? "running" : "idle"}
          renderMarkdown={renderMarkdown}
          onCopy={(text) => void copyText(text)}
          contentInsetTop={showChrome ? 16 : 64 - insets.top}
          onAnnotate={addAnnotation}
          draftAnnotations={annotations}
          onDraftAnnotationSelect={selectAnnotation}
          annotationRevealRef={reveal}
          renderAuthNeeded={renderAuthNeeded}
          trailing={
            questions.length > 0 ? (
              <HumanInputCard
                requests={questions}
                renderMarkdown={renderMarkdown}
                onSubmit={() => undefined}
              />
            ) : undefined
          }
        />
      </InteractiveAnswerProvider>
      {annotations.length > 0 ? (
        <View style={{ padding: 12, paddingBottom: insets.bottom + 12 }}>
          <AnnotationsChip
            annotations={annotations}
            onPress={() => setReview({ open: true, focusId: null })}
            onClear={() => setAnnotations([])}
          />
        </View>
      ) : null}
      <AnnotationsSheet
        open={review.open}
        onClose={() => setReview({ open: false, focusId: null })}
        annotations={annotations}
        editable
        focusId={review.focusId}
        onFocusConsumed={() => setReview((current) => ({ ...current, focusId: null }))}
        onUpdate={(id, note) =>
          setAnnotations((current) =>
            current.map((item) => (item.id === id ? { ...item, note } : item)),
          )
        }
        onRemove={(id) => setAnnotations((current) => current.filter((item) => item.id !== id))}
        onReveal={(source) => reveal.current?.(source) ?? false}
        onCommit={() => setReview({ open: false, focusId: null })}
      />
    </View>
  );
}

function Segments(props: {
  options: { id: string; label: string }[];
  selected: string;
  onSelect(id: string): void;
}) {
  const theme = useNativeTimelineTheme();
  return (
    <ScrollView
      contentContainerStyle={{ gap: 6, paddingHorizontal: 12 }}
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {props.options.map((option) => {
        const active = option.id === props.selected;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            key={option.id}
            onPress={() => props.onSelect(option.id)}
            style={{
              height: 30,
              paddingHorizontal: 12,
              borderRadius: 15,
              justifyContent: "center",
              backgroundColor: active ? theme.colors.fg : theme.colors["surface-2"],
            }}
          >
            <Text
              style={{
                color: active ? theme.colors.bg : theme.colors["fg-muted"],
                fontSize: 13,
                fontWeight: "600",
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
