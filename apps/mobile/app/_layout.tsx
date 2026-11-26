import { PurchasePresentationProvider } from "@opengeni/react/app/lib/purchase-presentation";
import { useRetainedReads } from "@opengeni/react/session";
import { OpenGeniReactNativeProvider } from "@opengeni/react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountProvider, useAccount } from "@/account";
import { AiConsentProvider } from "@/ai-consent";
import { restoreAppearance } from "@/appearance";
import { CallProvider } from "@/call";
import { AppInboxProvider } from "@/inbox-store";
import { restoreOutsideCallTarget } from "@/call-preferences";
import { AppLinkRouting } from "@/app-link-routing";
import { FeedbackHost } from "@/feedback/host";
import { MeetingRecorderProvider } from "@/meetings";
import { NotificationRouting } from "@/notifications";
import { canOpenLabRoutes } from "@/store-review";

// A link opened from outside lands on its screen with Home underneath, so Back works.
export const unstable_settings = { initialRouteName: "index" };

void restoreAppearance();
void restoreOutsideCallTarget();

function NativeEnvironment({ children }: { children: React.ReactNode }) {
  const { adapters, client } = useAccount();
  // Each signed-in account has its own client, so a conversation opened a
  // moment ago draws at once from memory and refreshes behind it. Switching or
  // signing out replaces the client, which drops everything kept.
  useRetainedReads(client);
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
    // The iOS app never offers purchases: chats and errors say what is
    // missing without a way to buy it, as hosted pages opened with client=ios do.
    <PurchasePresentationProvider showPurchasePrompts={Platform.OS !== "ios"}>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AccountProvider>
          <NativeEnvironment>
            <AiConsentProvider>
              <MeetingRecorderProvider>
                <AppInboxProvider>
                  <CallProvider>
                    {/* oxlint-disable-next-line react/style-prop-object -- expo-status-bar takes a string */}
                    <StatusBar style="auto" />
                    <NotificationRouting />
                    <AppLinkRouting />
                    <FeedbackHost />
                    <Stack screenOptions={{ headerShown: true }}>
                      <Stack.Screen name="index" options={{ title: "Opengeni" }} />
                      <Stack.Protected guard={canOpenLabRoutes(__DEV__)}>
                        <Stack.Screen name="lab" />
                        <Stack.Screen name="lab-call" />
                        <Stack.Screen name="lab-meeting" />
                        <Stack.Screen name="lab-app-review" />
                      </Stack.Protected>
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
                      <Stack.Screen name="inbox" options={{ title: "Inbox", animation: "none" }} />
                      {/* The bottom bar's places sit above Home and swap in place, like
                    tabs, so they appear without a slide. */}
                      <Stack.Screen
                        name="artifacts"
                        options={{ title: "Artifacts", animation: "none" }}
                      />
                      <Stack.Screen name="artifact/[id]" options={{ title: "" }} />
                      <Stack.Screen
                        name="meetings"
                        options={{ title: "Meetings", animation: "none" }}
                      />
                      <Stack.Screen name="meeting/[id]" options={{ title: "" }} />
                      <Stack.Screen name="automations" options={{ title: "Automations" }} />
                      <Stack.Screen name="automation/[id]" options={{ title: "" }} />
                      <Stack.Screen
                        name="automation-new"
                        // A page sheet like Feedback: it opens with the keyboard up, and
                        // a detented form sheet fights the keyboard over the layout.
                        options={{ headerShown: false, presentation: "modal" }}
                      />
                      <Stack.Screen name="session/[id]" options={{ title: "" }} />
                      <Stack.Screen name="settings" options={{ title: "Settings" }} />
                      <Stack.Screen name="ai-providers" options={{ title: "AI providers" }} />
                      <Stack.Screen name="delete-account" options={{ title: "Delete account" }} />
                      <Stack.Screen
                        name="voice-command"
                        // A page sheet, like a new automation: it opens with the keyboard up.
                        options={{ headerShown: false, presentation: "modal" }}
                      />
                      <Stack.Screen name="wake-phrase" options={{ title: "" }} />
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
                        // One sign-in sheet at a time: pushing it again goes to the open one.
                        dangerouslySingular
                        options={{ headerShown: false, presentation: "modal" }}
                      />
                      <Stack.Screen name="call" options={{ headerShown: false }} />
                      <Stack.Screen
                        name="feedback"
                        options={{ headerShown: false, presentation: "modal" }}
                      />
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
                </AppInboxProvider>
              </MeetingRecorderProvider>
            </AiConsentProvider>
          </NativeEnvironment>
        </AccountProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
    </PurchasePresentationProvider>
  );
}
