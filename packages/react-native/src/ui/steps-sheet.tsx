import type { ActivityItem } from "@opengeni/react/session";
import { Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentStepList } from "./timeline";
import type { AgentTheme } from "./theme";

/** Native sheet with the full step-by-step view of one piece of agent work. */
export function AgentStepsSheet(props: {
  visible: boolean;
  onClose(): void;
  title: string;
  steps: readonly ActivityItem[];
  theme: AgentTheme;
}) {
  const { theme } = props;
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
      visible={props.visible}
    >
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: Platform.OS === "ios" ? 0 : insets.top }}>
        <View style={{ height: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: theme.space.gutter }}>
          <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: theme.type.body + 1, fontWeight: theme.type.weightStrong }}>
            {props.title}
          </Text>
          <Pressable accessibilityRole="button" hitSlop={12} onPress={props.onClose} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: theme.colors.accent, fontSize: theme.type.body, fontWeight: "600" }}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: theme.space.gutter, paddingBottom: insets.bottom + 24 }}>
          <AgentStepList items={props.steps} theme={theme} />
        </ScrollView>
      </View>
    </Modal>
  );
}