import {
  BAR_MAX_FONT_SCALE,
  fontStyle,
  Icon,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  APP_TABS,
  EDGE_SWIPE_WIDTH,
  edgeSwipeOpensDrawer,
  TAB_BAR_HEIGHT,
  tabBarHeight,
  tabNavigation,
  type AppTab,
} from "@/app-tabs";
import { isCapturing, useMeetingRecorder } from "@/meetings";
import { dismissToHome } from "@/navigation";

/** Go to one of the bar's places from `from` (null: from the side menu or a chat). */
export function openTab(from: AppTab | null, to: AppTab): void {
  const plan = tabNavigation(from, to);
  switch (plan.kind) {
    case "stay":
      return;
    case "home":
      dismissToHome();
      return;
    case "push":
      router.push(plan.path);
      return;
    case "replace":
      router.replace(plan.path);
      return;
    case "home-then-push":
      dismissToHome();
      router.push(plan.path);
  }
}

const openChatsMenu = () => router.push("/sessions");

/**
 * One of the bar's places: its content, the bar docked under it, and a swipe
 * right from the left edge that opens the chats menu. The content is laid out
 * above the bar, so nothing scrolls or sits under it.
 */
export function TabScreen({ tab, children }: { tab: AppTab; children: ReactNode }) {
  // The pan may only start at the left edge and must move sideways first, so
  // taps and vertical scrolls everywhere else go to the screen as before.
  const edgeSwipe = Gesture.Pan()
    .runOnJS(true)
    .hitSlop({ left: 0, width: EDGE_SWIPE_WIDTH })
    .activeOffsetX(12)
    .failOffsetY([-16, 16])
    .onEnd((event) => {
      if (
        edgeSwipeOpensDrawer({
          startX: event.absoluteX - event.translationX,
          dx: event.translationX,
          dy: event.translationY,
          vx: event.velocityX,
        })
      ) {
        void Haptics.selectionAsync();
        openChatsMenu();
      }
    });
  return (
    <GestureDetector gesture={edgeSwipe}>
      <View style={{ flex: 1 }} collapsable={false}>
        <View style={{ flex: 1 }}>{children}</View>
        <AppTabBar current={tab} />
      </View>
    </GestureDetector>
  );
}

/**
 * The bar docked flush at the bottom, inside the safe area, with the place in
 * use filled. Meetings shows a red dot while a recording runs.
 */
export function AppTabBar({ current }: { current: AppTab }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const recording = isCapturing(useMeetingRecorder());
  const height = tabBarHeight(insets.bottom);
  return (
    <View
      style={{
        height,
        paddingBottom: height - TAB_BAR_HEIGHT,
        backgroundColor: c.bg,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: c.border,
      }}
    >
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: "row",
          height: TAB_BAR_HEIGHT,
          paddingHorizontal: 8,
          paddingVertical: 4,
          alignSelf: "center",
          width: "100%",
          maxWidth: 520,
        }}
      >
        {APP_TABS.map((entry) => {
          const selected = entry.tab === current;
          const live = entry.tab === "meetings" && recording;
          return (
            <Pressable
              key={entry.tab}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={live ? `${entry.label}, recording now` : entry.label}
              onPress={() => {
                if (selected) return;
                void Haptics.selectionAsync();
                openTab(current, entry.tab);
              }}
              style={({ pressed }) => ({
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
                gap: 3,
                borderRadius: (TAB_BAR_HEIGHT - 8) / 2,
                backgroundColor: selected
                  ? theme.scheme === "dark"
                    ? "rgba(255,255,255,0.12)"
                    : "rgba(0,0,0,0.06)"
                  : "transparent",
                opacity: pressed && !selected ? 0.6 : 1,
              })}
            >
              <View>
                <Icon name={entry.icon} size={20} color={selected ? c.fg : c["fg-muted"]} />
                {live ? (
                  <View
                    style={{
                      position: "absolute",
                      top: -1,
                      right: -4,
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: c.danger,
                    }}
                  />
                ) : null}
              </View>
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={BAR_MAX_FONT_SCALE}
                style={{
                  ...fontStyle(theme, selected ? 600 : 500),
                  fontSize: 11,
                  lineHeight: 14,
                  color: selected ? c.fg : c["fg-muted"],
                }}
              >
                {entry.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** The chats-menu button a place above Home shows where Back would be. */
function ChatsMenuButton() {
  const theme = useNativeTimelineTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open chats"
      hitSlop={8}
      onPress={openChatsMenu}
      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name="menu" size={20} color={theme.colors.fg} />
    </Pressable>
  );
}

/**
 * Header options for a place above Home: no Back (the bar moves between
 * places) and the chats menu in its spot, as on Home.
 */
export function tabHeaderOptions(renderThemed: (node: ReactNode) => ReactNode) {
  return {
    headerBackVisible: false,
    gestureEnabled: false,
    ...(Platform.OS === "ios"
      ? {
          unstable_headerLeftItems: () => [
            {
              type: "button" as const,
              label: "Chats",
              accessibilityLabel: "Open chats",
              icon: { type: "sfSymbol" as const, name: "line.3.horizontal" },
              onPress: openChatsMenu,
            },
          ],
        }
      : { headerLeft: () => renderThemed(<ChatsMenuButton />) }),
  };
}
