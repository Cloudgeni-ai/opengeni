import { compactModelPill } from "@opengeni/react/model-policy";
import { sessionDisplayTitle } from "@opengeni/react/session-list-model";
import { useOpenGeniNativeSession } from "@opengeni/react-native";
import {
  ComposerPill,
  ModelMark,
  ModelPickerSheet,
  NativeSessionScreen,
  SessionActionsButton,
  SessionHeaderTitle,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import { createWebMarkdownRenderer } from "@opengeni/react-native/timeline/markdown";
import * as Haptics from "expo-haptics";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { BrandMark } from "@/brand-mark";
import { copyText } from "@/clipboard";
import { useSessionComputeLabel } from "@/compute-label";
import { useWorkspaceModelCatalog } from "@/model-catalog";
import { ComposerPlusMenu } from "@/new-session-options";
import { AppThemeProvider } from "@/theme";
import { useComposerVoice } from "@/voice";

const renderMarkdown = createWebMarkdownRenderer({ onCopy: (text) => void copyText(text) });

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client, models, workspaceId } = useAccount();
  if (!workspaceId || !id) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>No workspace selected</Text>
      </View>
    );
  }
  return (
    <AppThemeProvider>
      <LiveSession client={client} models={models} sessionId={id} workspaceId={workspaceId} />
    </AppThemeProvider>
  );
}

function LiveSession(props: {
  client: ReturnType<typeof useAccount>["client"];
  models: ReturnType<typeof useAccount>["models"];
  sessionId: string;
  workspaceId: string;
}) {
  const theme = useNativeTimelineTheme();
  const insets = useSafeAreaInsets();
  const controller = useOpenGeniNativeSession({
    client: props.client,
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
  });
  const session = controller.session.session;
  const feedback = useMemo(
    () => ({ client: props.client, workspaceId: props.workspaceId, sessionId: props.sessionId }),
    [props.client, props.workspaceId, props.sessionId],
  );
  const catalog = useWorkspaceModelCatalog(props.workspaceId);
  const computeLabel = useSessionComputeLabel(props.workspaceId, props.sessionId);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The composer owns the next turn's policy, exactly as the web picker edits it.
  const composer = controller.composer;
  const voice = useComposerVoice({
    workspaceId: props.workspaceId,
    value: composer.value,
    setValue: composer.setValue,
    scope: props.sessionId,
  });
  const policy = composer.policy ?? null;
  const model = policy?.model ?? session?.model ?? null;
  const effort = policy?.reasoningEffort ?? session?.reasoningEffort ?? null;
  // The web composer's phone-width pill: compact model name, effort when it is a choice.
  const pill = model ? compactModelPill(props.models, model, effort ?? undefined) : null;
  const status = controller.sessionStatus;
  const paused = controller.queue.effectiveControl?.state === "paused";
  // Web header: the status badge beside the title (a paused workstream says so).
  const refreshSession = controller.session.refresh;
  const title = session ? sessionDisplayTitle(session) : "";
  const headerTitle = useCallback(
    () => (
      <AppThemeProvider>
        <SessionHeaderTitle
          title={title}
          status={paused ? "queued" : status}
          statusLabel={paused ? "Paused" : undefined}
        />
      </AppThemeProvider>
    ),
    [paused, status, title],
  );
  const headerRight = useCallback(
    () =>
      session ? (
        <AppThemeProvider>
          <SessionActionsButton
            session={session}
            client={props.client}
            onChanged={() => void refreshSession()}
            onActionFeedback={() => void Haptics.selectionAsync()}
          />
        </AppThemeProvider>
      ) : null,
    [props.client, refreshSession, session],
  );
  // Photos and files, as the web composer's + offers them.
  const attachMenu = (
    <ComposerPlusMenu
      onPickImages={() => void controller.attachments.pickImages()}
      onPickFiles={() => void controller.attachments.pickDocuments()}
    />
  );
  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerTitle,
          headerRight,
          headerStyle: { backgroundColor: theme.colors.bg },
          headerTintColor: theme.colors.fg,
          headerShadowVisible: false,
        }}
      />
      <NativeSessionScreen
        controller={controller}
        renderMarkdown={renderMarkdown}
        onCopy={(text) => void copyText(text)}
        onOpenSession={(sessionId) => router.push(`/session/${sessionId}`)}
        bottomInset={insets.bottom}
        computeLabel={computeLabel}
        feedback={feedback}
        composer={{
          onActionFeedback: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
          voice,
          renderLeading: () => attachMenu,
          options: pill ? (
            <ComposerPill
              label={pill.effort ? `${pill.name} · ${pill.effort}` : pill.name}
              leading={<ModelMark model={model ?? ""} size={14} color={theme.colors.fg} />}
              onPress={
                policy
                  ? () => {
                      catalog.refresh();
                      setPickerOpen(true);
                    }
                  : undefined
              }
            />
          ) : null,
        }}
      />
      {policy ? (
        <ModelPickerSheet
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          rows={catalog.rows}
          loading={catalog.loading && catalog.rows.length === 0}
          error={catalog.error}
          model={policy.model}
          effort={policy.reasoningEffort}
          latencyMode={policy.latencyMode}
          hasImageAttachments={controller.attachments.attachments.some(
            (file) => file.status !== "failed" && file.contentType.startsWith("image/"),
          )}
          codexOnly={session?.codexCompactionMode === "remote_v2"}
          groupPresentation={{
            opengeni_credits: {
              label: "Opengeni",
              icon: <BrandMark width={15} color={theme.colors["fg-subtle"]} />,
            },
          }}
          onModelChange={composer.setModel}
          onEffortChange={composer.setReasoningEffort}
          onLatencyModeChange={composer.setLatencyMode}
          onSelectionFeedback={() => void Haptics.selectionAsync()}
        />
      ) : null}
    </>
  );
}
