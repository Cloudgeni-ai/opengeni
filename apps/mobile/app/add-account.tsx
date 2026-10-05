import { Stack, router } from "expo-router";
import { SignInScreen } from "@/sign-in-screen";
import { AppThemeProvider } from "@/theme";

export default function AddAccountScreen() {
  return (
    <AppThemeProvider>
      <Stack.Screen options={{ headerShown: false, presentation: "modal" }} />
      <SignInScreen onDone={() => router.dismissAll()} onCancel={() => router.back()} />
    </AppThemeProvider>
  );
}
