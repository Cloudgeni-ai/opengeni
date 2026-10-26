import { useMeetingView, type MeetingAction } from "@opengeni/react-native/meetings";
import { IconButton, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useRef } from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { WorkspaceGate } from "@/meetings";
import { NativeMenu, type MenuAction } from "@/native-menu";
import { AppThemeProvider } from "@/theme";

export default function MeetingScreen() {
  return (
    <AppThemeProvider>
      <WorkspaceGate title="Meeting">
        {(workspaceId) => <Meeting workspaceId={workspaceId} />}
      </WorkspaceGate>
    </AppThemeProvider>
  );
}

function Meeting({ workspaceId }: { workspaceId: string }) {
  const c = useNativeTimelineTheme().colors;
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useAccount();
  const view = useMeetingView({
    client,
    workspaceId,
    recordingId: id ?? null,
    onDeleted: () => router.back(),
    // iOS keeps the transcript clear of the home indicator by itself.
    bottomInset: Platform.OS === "ios" ? 0 : insets.bottom,
  });
  const actions = view.actions;
  // Android's header menu: rebuilt only when its items change; the handler is read live.
  const runAction = useRef(view.runAction);
  runAction.current = view.runAction;
  const actionsKey = actions
    .map((action) => `${action.id}:${action.title}:${action.disabled ? 1 : 0}`)
    .join("|");
  const menuButton = useCallback(
    () => (
      <NativeMenu
        actions={actions.map(menuAction)}
        onPressAction={({ nativeEvent }) =>
          runAction.current(nativeEvent.event as MeetingAction["id"])
        }
      >
        <IconButton icon="ellipsis" accessibilityLabel="Meeting actions" />
      </NativeMenu>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actionsKey],
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: "",
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
          ...(actions.length > 0
            ? Platform.OS === "ios"
              ? {
                  unstable_headerRightItems: () => [
                    {
                      type: "menu" as const,
                      label: "Meeting actions",
                      accessibilityLabel: "Meeting actions",
                      icon: { type: "sfSymbol" as const, name: "ellipsis" },
                      menu: {
                        items: actions.map((action) => {
                          const image = menuAction(action).image;
                          return {
                            type: "action" as const,
                            label: action.title,
                            ...(typeof image === "string"
                              ? { icon: { type: "sfSymbol" as const, name: image } }
                              : {}),
                            ...(action.destructive ? { destructive: true } : {}),
                            ...(action.disabled ? { disabled: true } : {}),
                            onPress: () => view.runAction(action.id),
                          };
                        }),
                      },
                    },
                  ],
                }
              : { headerRight: menuButton }
            : {}),
        }}
      />
      {view.content}
    </>
  );
}

function menuAction(action: MeetingAction): MenuAction {
  return {
    id: action.id,
    title: action.title,
    image: action.systemImage as MenuAction["image"],
    attributes: {
      ...(action.destructive ? { destructive: true } : {}),
      ...(action.disabled ? { disabled: true } : {}),
    },
  };
}
