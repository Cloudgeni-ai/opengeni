import { OpenGeniReactNativeProvider } from "@opengeni/react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountProvider, useAccount } from "@/account";
import { restoreAppearance } from "@/appearance";
import { CallProvider } from "@/call";
import { restoreOutsideCallTarget } from "@/call-preferences";
import { AppLinkRouting } from "@/app-link-routing";
import { NotificationRouting } from "@/notifications";

// A link opened from outside lands on its screen with Home underneath, so Back works.
export const unstable_settings = { initialRouteName: "index" };

void restoreAppearance();
void restoreOutsideCallTarget();

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
            <CallProvider>
              {/* oxlint-disable-next-line react/style-prop-object -- expo-status-bar takes a string */}
              <StatusBar style="auto" />
              <NotificationRouting />
              <AppLinkRouting />
              <Stack screenOptions={{ headerShown: true }}>
                <Stack.Screen name="index" options={{ title: "Opengeni" }} />
                {/* The sessions list is the menu behind Home's top-left button, so it
                    slides in from the left like a side menu and slides back out to the
                    left; a swipe to the left closes it, matching the motion. */}
                <Stack.Screen
                  name="sessions"
                  options={{
                    title: "Sessions",
                    animation: "slide_from_left",
                    animationMatchesGesture: true,
                    fullScreenGestureEnabled: true,
                  }}
                />
                <Stack.Screen name="inbox" options={{ title: "Inbox" }} />
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
                <Stack.Screen name="call" options={{ headerShown: false }} />
                <Stack.Screen
                  name="open"
                  options={{
                    headerShown: false,
                    animation: "none",
                    presentation: "transparentModal",
                  }}
                />
              </Stack>
            </CallProvider>
          </NativeEnvironment>
        </AccountProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
