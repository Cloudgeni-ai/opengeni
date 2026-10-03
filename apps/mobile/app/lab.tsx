// Reference lab: the deterministic web fixture scenarios through the native
// MessageTimeline, for side-by-side comparison with the web harness
// (/dev/session-timeline). Deep link: opengeni://lab?scenario=working&scheme=dark&chrome=0
import { labScenarios, type LabScenarioId } from "@opengeni/react/testing";
import { MessageTimeline, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { createWebMarkdownRenderer } from "@opengeni/react-native/timeline/markdown";
import { copyText } from "@/clipboard";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppThemeProvider } from "@/theme";

type Params = { scenario?: LabScenarioId; scheme?: "light" | "dark"; chrome?: string };

const renderMarkdown = createWebMarkdownRenderer({ onCopy: (text) => void copyText(text) });

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
  const theme = useNativeTimelineTheme();
  const insets = useSafeAreaInsets();
  const scenarios = useMemo(() => labScenarios(), []);
  const scenarioId = params.scenario ?? "working";
  const scenario = scenarios.find((entry) => entry.id === scenarioId) ?? scenarios[0]!;
  const showChrome = params.chrome !== "0";
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
      <MessageTimeline
        key={scenario.id}
        events={scenario.events}
        status={scenario.running ? "running" : "idle"}
        renderMarkdown={renderMarkdown}
        onCopy={(text) => void copyText(text)}
        contentInsetTop={showChrome ? 16 : 64 - insets.top}
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
