import { automationWhenWords } from "@opengeni/react/automation-model";
import { useOpenGeniText, type OpenGeniText } from "@opengeni/react/messages";
import { IconButton, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import type { EventSource } from "@opengeni/sdk";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { useAccount } from "@/account";
import {
  automationPermissions,
  automationStateWord,
  lastRunWords,
  useAutomationList,
  type AutomationEntry,
} from "@/automations";
import { WorkspaceGate } from "@/meetings";
import { SettingsList } from "@/settings-list";
import type { SettingsRow, SettingsSection } from "@/settings-model";
import { AppThemeProvider } from "@/theme";

/** How often an open list re-reads, so a run that starts or finishes shows up. */
const REFRESH_MS = 30_000;

const createAutomation = () => router.push("/automation-new");

/** Android's header +; iOS draws its own bar button. */
function NewAutomationButton() {
  return <IconButton icon="plus" accessibilityLabel="New automation" onPress={createAutomation} />;
}

export default function AutomationsScreen() {
  return (
    <AppThemeProvider>
      <WorkspaceGate title="Automations" message="Choose a workspace to see its automations.">
        {(workspaceId) => <Automations workspaceId={workspaceId} />}
      </WorkspaceGate>
    </AppThemeProvider>
  );
}

/* The web Automations list at phone width: each automation with when it runs
   and what it last did, a word at the end for one that won't run (Paused,
   Finished) or keeps failing, and + to describe a new one to a chat. */
function Automations({ workspaceId }: { workspaceId: string }) {
  const t = useOpenGeniText();
  const c = useNativeTimelineTheme().colors;
  const { client, accessContext } = useAccount();
  const { list, error, refresh } = useAutomationList(client, workspaceId);
  const [now, setNow] = useState(() => new Date());
  const reload = useCallback(async () => {
    await refresh();
    setNow(new Date());
  }, [refresh]);
  // Fresh each time the screen comes to the front, and every half minute while it stays there.
  useFocusEffect(
    useCallback(() => {
      void reload();
      const timer = setInterval(() => void reload(), REFRESH_MS);
      return () => clearInterval(timer);
    }, [reload]),
  );
  const canCreate = automationPermissions(accessContext, workspaceId).canCreate;
  const header = (
    <Stack.Screen
      options={{
        title: "Automations",
        headerStyle: { backgroundColor: c.bg },
        headerTintColor: c.fg,
        headerShadowVisible: false,
        ...(canCreate
          ? Platform.OS === "ios"
            ? {
                unstable_headerRightItems: () => [
                  {
                    type: "button" as const,
                    label: "New automation",
                    accessibilityLabel: "New automation",
                    icon: { type: "sfSymbol" as const, name: "plus" },
                    onPress: createAutomation,
                  },
                ],
              }
            : { headerRight: NewAutomationButton }
          : {}),
      }}
    />
  );

  if (!list && !error) {
    return (
      <>
        {header}
        <View style={{ flex: 1, backgroundColor: c.bg, alignItems: "center" }}>
          <ActivityIndicator style={{ marginTop: 48 }} color={c["fg-muted"]} />
        </View>
      </>
    );
  }

  const sections: SettingsSection[] = [];
  if (list && list.entries.length > 0) {
    sections.push({
      id: "automations",
      ...(error ? { footer: "Couldn't refresh the list. Pull down to try again." } : {}),
      rows: list.entries.map((entry) => automationRow(t, entry, list.sources, now)),
    });
  } else if (!list && error) {
    sections.push({
      id: "error",
      title: "Couldn't load automations",
      footer: error.message,
      rows: [{ kind: "action", id: "retry", title: "Try again", onPress: () => void reload() }],
    });
  }
  return (
    <>
      {header}
      <SettingsList
        sections={sections}
        onRefresh={reload}
        empty={{
          title: "No automations yet",
          symbol: "bolt",
          description: canCreate
            ? "Automations run a task on a schedule or when something happens. Tap + and say what should happen."
            : "Automations run a task on a schedule or when something happens. The ones in this workspace show here.",
        }}
      />
    </>
  );
}

function automationRow(
  t: OpenGeniText,
  { task, lastRun }: AutomationEntry,
  sources: readonly EventSource[],
  now: Date,
): SettingsRow {
  const when = automationWhenWords(t, task, sources, now);
  const last = lastRunWords(t, lastRun, now);
  // Runs that keep failing say so; a schedule that paused itself says Paused in red.
  const failing = task.blocker?.state === "notified" && task.status === "active";
  const state = failing ? "Failing" : automationStateWord(task);
  return {
    kind: "navigate",
    id: task.id,
    title: task.name,
    subtitle: last ? `${when}\n${last}` : when,
    ...(state ? { detail: state } : {}),
    ...(task.blocker ? { detailTone: "danger" as const } : {}),
    onPress: () => router.push(`/automation/${task.id}`),
  };
}
