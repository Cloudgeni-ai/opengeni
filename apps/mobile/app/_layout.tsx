import { OpenGeniReactNativeProvider } from "@opengeni/react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountProvider, useAccount } from "@/account";
import { restoreAppearance } from "@/appearance";
import { NotificationRouting } from "@/notifications";

void restoreAppearance();

function NativeEnvironment({ children }: { children: React.ReactNode }) {
  const { adapters } = useAccount();
  return (
    <OpenGeniReactNativeProvider
      adapters={adapters}
      loadingFallback={
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator />
        </View>
      }
    >
      {children}
    </OpenGeniReactNativeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AccountProvider>
          <NativeEnvironment>
            {/* oxlint-disable-next-line react/style-prop-object -- expo-status-bar takes a string */}
            <StatusBar style="auto" />
            <NotificationRouting />
            <Stack screenOptions={{ headerShown: true }}>
              <Stack.Screen name="index" options={{ title: "Opengeni" }} />
              <Stack.Screen name="sessions" options={{ title: "Sessions" }} />
              <Stack.Screen name="session/[id]" options={{ title: "" }} />
              <Stack.Screen name="settings" options={{ title: "Settings" }} />
              <Stack.Screen
                name="workspaces"
                options={{
                  title: "Workspaces",
                  headerShown: false,
                  presentation: "formSheet",
                  sheetAllowedDetents: [0.55, 1],
                  sheetGrabberVisible: true,
                }}
              />
              <Stack.Screen
                name="add-account"
                options={{ headerShown: false, presentation: "modal" }}
              />
            </Stack>
          </NativeEnvironment>
        </AccountProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
