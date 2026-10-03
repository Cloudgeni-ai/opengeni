import { OpenGeniNativeSessionView, useOpenGeniNativeSession } from "@opengeni/react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client, workspaceId } = useAccount();
  if (!workspaceId || !id) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>No workspace selected</Text>
      </View>
    );
  }
  return <LiveSession client={client} sessionId={id} workspaceId={workspaceId} />;
}

function LiveSession(props: {
  client: ReturnType<typeof useAccount>["client"];
  sessionId: string;
  workspaceId: string;
}) {
  const insets = useSafeAreaInsets();
  const controller = useOpenGeniNativeSession({
    client: props.client,
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
  });
  return (
    <>
      <Stack.Screen options={{ title: controller.session.session?.title ?? "" }} />
      <OpenGeniNativeSessionView
        composerSafeAreaInsets={{ bottom: insets.bottom, left: insets.left, right: insets.right }}
        controller={controller}
        keyboardVerticalOffset={insets.top + 44}
      />
    </>
  );
}
