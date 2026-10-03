// Design lab: every direction × scenario × color scheme, rendered from deterministic
// fixtures through the official timeline projection. Deep-link:
// opengeni://lab?direction=calm&scenario=working&scheme=dark&chrome=0
import {
  buildTimeline,
  groupTimeline,
  projectPendingApprovals,
  projectPendingHumanInputRequests,
} from "@opengeni/react/session";
import { labScenarios, type LabScenarioId } from "@opengeni/react-native/lab";
import {
  AgentAttentionTray,
  AgentComposer,
  AgentIcon,
  AgentStepsSheet,
  AgentTimeline,
  ComposerChip,
  agentDirections,
  agentTheme,
  type AgentDirectionId,
  type AgentTheme,
} from "@opengeni/react-native/ui";
import type { ActivityItem } from "@opengeni/react/session";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { renderAgentMarkdown } from "@/markdown";

type Params = {
  direction?: AgentDirectionId;
  scenario?: LabScenarioId;
  scheme?: "light" | "dark";
  chrome?: string;
  attention?: "tray" | "inline";
};

export default function DesignLab() {
  const params = useLocalSearchParams<Params>();
  const direction = params.direction ?? "calm";
  const scenarioId = params.scenario ?? "working";
  const scheme = params.scheme ?? "light";
  const showChrome = params.chrome !== "0";
  const attention = params.attention ?? "tray";
  const theme = useMemo(() => agentTheme(direction, scheme), [direction, scheme]);
  const insets = useSafeAreaInsets();
  const scenarios = useMemo(() => labScenarios(), []);
  const scenario = scenarios.find((entry) => entry.id === scenarioId) ?? scenarios[0]!;
  const groups = useMemo(() => groupTimeline(buildTimeline(scenario.events), { readableTurns: true }), [scenario]);
  const [resolved, setResolved] = useState<string[]>([]);
  const approvals = useMemo(
    () => projectPendingApprovals(scenario.events).filter((entry) => !resolved.includes(entry.id)),
    [scenario, resolved],
  );
  const humanInput = useMemo(
    () => projectPendingHumanInputRequests(scenario.events).filter((entry) => !resolved.includes(entry.id)),
    [scenario, resolved],
  );
  const resolve = (id: string) => setResolved((current) => [...current, id]);
  const [sheet, setSheet] = useState<{ title: string; steps: ActivityItem[] } | null>(null);
  const [draft, setDraft] = useState("");
  const set = (next: Partial<Params>) => router.setParams({ direction, scenario: scenarioId, scheme, chrome: params.chrome ?? "1", ...next });

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <LabHeader theme={theme} title={scenario.title} topInset={insets.top} />
      {showChrome ? (
        <View style={{ gap: 6, paddingBottom: 8, borderBottomWidth: 1, borderColor: theme.colors.border }}>
          <Segments
            onSelect={(id) => set({ direction: id as AgentDirectionId })}
            options={agentDirections.map((entry) => ({ id: entry.id, label: entry.name }))}
            selected={direction}
            theme={theme}
          />
          <Segments
            onSelect={(id) => set({ scenario: id as LabScenarioId })}
            options={scenarios.map((entry) => ({ id: entry.id, label: entry.title }))}
            selected={scenarioId}
            theme={theme}
          />
          <Segments
            onSelect={(id) => set({ scheme: id as "light" | "dark" })}
            options={[
              { id: "light", label: "Light" },
              { id: "dark", label: "Dark" },
            ]}
            selected={scheme}
            theme={theme}
          />
        </View>
      ) : null}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <AgentTimeline
          approvals={approvals}
          attentionPlacement={attention}
          groups={groups}
          humanInput={humanInput}
          onAnswer={resolve}
          onApproval={resolve}
          onOpenSteps={(steps, title) => setSheet({ steps, title })}
          renderMarkdown={renderAgentMarkdown}
          running={scenario.running}
          theme={theme}
        />
        {attention === "tray" ? (
          <AgentAttentionTray
            approvals={approvals}
            humanInput={humanInput}
            onAnswer={resolve}
            onApproval={resolve}
            theme={theme}
          />
        ) : null}
        <AgentComposer
          accessories={
            <>
              <ComposerChip label="Luna · low" theme={theme} />
              <ComposerChip label="Ask first" theme={theme} />
            </>
          }
          bottomInset={insets.bottom}
          onChangeText={setDraft}
          onSend={() => setDraft("")}
          placeholder="Message the agent"
          running={scenario.running}
          theme={theme}
          value={draft}
        />
      </KeyboardAvoidingView>
      <AgentStepsSheet
        onClose={() => setSheet(null)}
        steps={sheet?.steps ?? []}
        theme={theme}
        title={sheet?.title ?? ""}
        visible={sheet !== null}
      />
    </View>
  );
}

function LabHeader({ theme, title, topInset }: { theme: AgentTheme; title: string; topInset: number }) {
  return (
    <View style={{ paddingTop: topInset, backgroundColor: theme.colors.background }}>
      <View style={{ height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 8 }}>
        <Pressable accessibilityLabel="Back" hitSlop={10} onPress={() => router.back()} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
          <View style={{ transform: [{ rotate: "180deg" }] }}>
            <AgentIcon color={theme.colors.text} name="chevron-right" size={22} />
          </View>
        </Pressable>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 16, fontWeight: "600" }}>
            {title}
          </Text>
        </View>
        <View style={{ width: 40 }} />
      </View>
    </View>
  );
}

function Segments(props: { options: { id: string; label: string }[]; selected: string; onSelect(id: string): void; theme: AgentTheme }) {
  const { theme } = props;
  return (
    <ScrollView contentContainerStyle={{ gap: 6, paddingHorizontal: 12 }} horizontal showsHorizontalScrollIndicator={false}>
      {props.options.map((option) => {
        const active = option.id === props.selected;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            key={option.id}
            onPress={() => props.onSelect(option.id)}
            style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: "center", backgroundColor: active ? theme.colors.text : theme.colors.surface }}
          >
            <Text style={{ color: active ? theme.colors.background : theme.colors.textMuted, fontSize: 13, fontWeight: "600" }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}