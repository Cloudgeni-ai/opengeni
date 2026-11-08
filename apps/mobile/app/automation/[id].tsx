import { automationWhenWords, isFinishedOnce } from "@opengeni/react/automation-model";
import { useOpenGeniText } from "@opengeni/react/messages";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import type { ScheduledTask, ScheduledTaskRun } from "@opengeni/sdk";
import * as Haptics from "expo-haptics";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import { useAccount } from "@/account";
import {
  automationPermissions,
  cachedAutomationList,
  forgetAutomation,
  nextRunWords,
  rememberAutomation,
  runIsLive,
  runRowWords,
} from "@/automations";
import { WorkspaceGate } from "@/meetings";
import { SettingsList } from "@/settings-list";
import type { SettingsRow, SettingsSection } from "@/settings-model";
import { AppThemeProvider } from "@/theme";
import { openOnWeb, webPaths } from "@/web-links";

/** How many runs the page lists, newest first. */
const RUN_LIMIT = 20;
/** How often the runs re-read while one is still going. */
const LIVE_REFRESH_MS = 10_000;

export default function AutomationScreen() {
  return (
    <AppThemeProvider>
      <WorkspaceGate title="Automation" message="Choose a workspace to see its automations.">
        {(workspaceId) => <Automation workspaceId={workspaceId} />}
      </WorkspaceGate>
    </AppThemeProvider>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* One automation, as its web page at phone width: on or off and when it runs
   next, Run now, the chat its runs work in, its instructions, what its recent
   runs did (each opens its chat), and Delete. Its form and event triggers
   stay on the web. */
function Automation({ workspaceId }: { workspaceId: string }) {
  const t = useOpenGeniText();
  const c = useNativeTimelineTheme().colors;
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client, accessContext, account } = useAccount();
  const cached = cachedAutomationList(workspaceId);
  const kept = cached?.entries.find((entry) => entry.task.id === id);
  const [task, setTask] = useState<ScheduledTask | null>(kept?.task ?? null);
  const [runs, setRuns] = useState<ScheduledTaskRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const gone = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    const [nextTask, nextRuns] = await Promise.allSettled([
      client.getScheduledTask(workspaceId, id),
      client.listScheduledTaskRuns(workspaceId, id, { limit: RUN_LIMIT }),
    ]);
    if (gone.current) return;
    setNow(new Date());
    if (nextTask.status === "fulfilled") {
      setTask(nextTask.value);
      setLoadError(null);
      rememberAutomation(workspaceId, nextTask.value);
    } else {
      setLoadError(errorText(nextTask.reason));
    }
    if (nextRuns.status === "fulfilled") setRuns(nextRuns.value);
  }, [client, workspaceId, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  // A run still going re-reads until it finishes, so its outcome shows up here.
  const live = runs?.some((run) => runIsLive(run)) ?? false;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  const header = (title: string) => (
    <Stack.Screen
      options={{
        title,
        headerStyle: { backgroundColor: c.bg },
        headerTintColor: c.fg,
        headerShadowVisible: false,
      }}
    />
  );

  if (!task) {
    return (
      <>
        {header("")}
        {loadError ? (
          <SettingsList
            sections={[
              {
                id: "error",
                title: "Couldn't open this automation",
                footer: loadError,
                rows: [
                  { kind: "action", id: "retry", title: "Try again", onPress: () => void load() },
                ],
              },
            ]}
          />
        ) : (
          <View style={{ flex: 1, backgroundColor: c.bg, alignItems: "center" }}>
            <ActivityIndicator style={{ marginTop: 48 }} color={c["fg-muted"]} />
          </View>
        )}
      </>
    );
  }

  const may = automationPermissions(accessContext, workspaceId, task);
  const finished = isFinishedOnce(task);
  const next = nextRunWords(t, task, now);
  const sources = cached?.sources ?? [];

  const setOn = async (turnOn: boolean) => {
    const before = task;
    // The switch moves at once (a finished run-once one starts listening
    // again); a refusal puts it back and says why.
    setTask({
      ...task,
      status: turnOn ? "active" : "paused",
      ...(turnOn && task.events ? { events: { ...task.events, completedAt: null } } : {}),
    });
    void Haptics.selectionAsync().catch(() => undefined);
    try {
      const saved = turnOn
        ? await client.resumeScheduledTask(workspaceId, task.id)
        : await client.pauseScheduledTask(workspaceId, task.id);
      if (gone.current) return;
      setTask(saved);
      rememberAutomation(workspaceId, saved);
    } catch (error) {
      if (gone.current) return;
      setTask(before);
      Alert.alert(
        turnOn ? "Couldn't turn the automation on" : "Couldn't pause the automation",
        errorText(error),
      );
    }
  };

  const runNow = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await client.triggerScheduledTask(workspaceId, task.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      await load();
    } catch (error) {
      Alert.alert("Couldn't start a run", errorText(error));
    } finally {
      if (!gone.current) setStarting(false);
    }
  };

  const confirmDelete = () => {
    const stops = next ? `It stops running. The next run was ${next}.` : "It won't run again.";
    Alert.alert(
      `Delete ${task.name}?`,
      `${stops} Chats from earlier runs stay in your chats. This can't be undone; switch it off instead to keep it for later.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await client.deleteScheduledTask(workspaceId, task.id);
                gone.current = true;
                forgetAutomation(workspaceId, task.id);
                if (router.canGoBack()) router.back();
              } catch (error) {
                Alert.alert("Couldn't delete the automation", errorText(error));
              }
            })();
          },
        },
      ],
    );
  };

  const on = task.status === "active" && !finished;
  const statusSubtitle = finished
    ? "Finished. Turn it on to run again on the next matching event."
    : task.status === "paused"
      ? "Paused. It won't run until you turn it on."
      : next
        ? `Next run ${next}`
        : task.events
          ? "Runs when a matching event arrives"
          : undefined;

  const sections: SettingsSection[] = [
    {
      id: "status",
      ...(task.blocker ? { footer: task.blocker.message } : {}),
      rows: [
        {
          kind: "toggle",
          id: "on",
          title: "On",
          ...(statusSubtitle ? { subtitle: statusSubtitle } : {}),
          value: on,
          disabled: !may.canManage,
          onChange: (value) => void setOn(value),
        },
        {
          kind: "info",
          id: "when",
          title: "When",
          value: automationWhenWords(t, task, sources, now),
        },
      ],
    },
  ];

  const actions: SettingsRow[] = [];
  if (may.canRun) {
    actions.push({
      kind: "action",
      id: "run-now",
      title: starting ? "Starting…" : "Run now",
      symbol: "play",
      onPress: () => void runNow(),
    });
  }
  if (task.targetSessionId) {
    const sessionId = task.targetSessionId;
    actions.push({
      kind: "action",
      id: "open-chat",
      title: "Open its chat",
      subtitle: "Every run continues this chat",
      symbol: "bubble.left",
      onPress: () => router.push(`/session/${sessionId}`),
    });
  }
  if (account) {
    actions.push({
      kind: "external",
      id: "edit",
      title: may.canManage ? "Edit on the web" : "Open on the web",
      symbol: "safari",
      onPress: () => openOnWeb(account.baseUrl, webPaths.automation(workspaceId, task.id)),
    });
  }
  if (actions.length > 0) sections.push({ id: "actions", rows: actions });

  const prompt = task.agentConfig.prompt.trim();
  if (prompt) {
    sections.push({
      id: "instructions",
      title: "Instructions",
      rows: [{ kind: "text", id: "prompt", text: prompt, lines: 4 }],
    });
  }

  sections.push({
    id: "runs",
    title: "Recent runs",
    ...(runs === null
      ? { footer: "Loading…" }
      : runs.length === 0
        ? { footer: "No runs yet." }
        : {}),
    rows: (runs ?? []).map((run): SettingsRow => {
      const words = runRowWords(t, run, now);
      const sessionId = run.sessionId;
      return {
        kind: "navigate",
        id: run.id,
        title: words.title,
        subtitle: words.subtitle,
        detail: words.status,
        ...(words.failed ? { detailTone: "danger" as const } : {}),
        ...(sessionId ? { onPress: () => router.push(`/session/${sessionId}`) } : {}),
      };
    }),
  });

  if (may.canManage) {
    sections.push({
      id: "delete",
      rows: [
        {
          kind: "destructive",
          id: "delete",
          title: "Delete automation",
          symbol: "trash",
          onPress: confirmDelete,
        },
      ],
    });
  } else if (task.ownerSubjectId && task.ownerSubjectId !== accessContext?.subjectId) {
    sections.push({
      id: "owner",
      footer: "Only the person who owns this automation can change or run it.",
      rows: [],
    });
  } else {
    sections.push({
      id: "owner",
      footer: "You don't have permission to change automations in this workspace.",
      rows: [],
    });
  }

  return (
    <>
      {header(task.name)}
      <SettingsList sections={sections} onRefresh={load} />
    </>
  );
}
