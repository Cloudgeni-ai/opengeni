import { OpenGeniReactNativeProvider } from "@opengeni/react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountProvider, useAccount } from "@/account";

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
            <Stack screenOptions={{ headerShown: true }}>
              <Stack.Screen name="index" options={{ title: "OpenGeni" }} />
              <Stack.Screen name="session/[id]" options={{ title: "" }} />
            </Stack>
          </NativeEnvironment>
        </AccountProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
