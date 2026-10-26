/**
 * The app's one meeting recorder, held above the screens so a recording keeps
 * going while the person moves around the app (and, with the native module,
 * while the phone is locked or another app is in front).
 *
 * Audio is written to this phone's storage as it is captured and uploaded in
 * the background. Unsent audio is kept per signed-in account and only ever
 * uploaded with that account's credential; recordings the app could not
 * finish (killed, offline) finish the next time that account is active.
 */
import {
  MeetingRecorderProvider as SharedRecorderProvider,
  isCapturing,
  useMeetingRecorder,
  type MeetingRecorder,
} from "@opengeni/react-native/meetings";
import { fontStyle, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack } from "expo-router";
import type { ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useAccount } from "@/account";

export { isCapturing, useMeetingRecorder, type MeetingRecorder };

export function MeetingRecorderProvider({ children }: { children: ReactNode }) {
  const { account, client, workspaceId } = useAccount();
  if (!account || !workspaceId) return <>{children}</>;
  // A new account is a new client and a new store: start a fresh recorder.
  return (
    <SharedRecorderProvider
      key={account.id}
      client={client}
      workspaceId={workspaceId}
      storeScope={account.id}
    >
      {children}
    </SharedRecorderProvider>
  );
}

/**
 * Meetings belong to a workspace. Until one is chosen (a new account, or the
 * workspace list still loading) say so instead of rendering the screen.
 */
export function WorkspaceGate({
  title,
  children,
}: {
  title: string;
  children: (workspaceId: string) => ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { status, workspaceId } = useAccount();
  if (workspaceId) return <>{children(workspaceId)}</>;
  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
        }}
      />
      <View style={{ flex: 1, backgroundColor: c.bg, padding: 24, alignItems: "center" }}>
        {status === "loading" ? (
          <ActivityIndicator style={{ marginTop: 24 }} color={c["fg-muted"]} />
        ) : (
          <Text
            style={{
              ...fontStyle(theme),
              fontSize: 15,
              lineHeight: 21,
              color: c["fg-muted"],
              textAlign: "center",
              marginTop: 24,
            }}
          >
            Choose a workspace to record and see its meetings.
          </Text>
        )}
      </View>
    </>
  );
}
