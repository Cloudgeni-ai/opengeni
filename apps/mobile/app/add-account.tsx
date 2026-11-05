import { Stack, router, useLocalSearchParams } from "expo-router";
import { useAccount } from "@/account";
import { SignInScreen } from "@/sign-in-screen";
import { dismissToHome } from "@/navigation";
import { AppThemeProvider } from "@/theme";

/**
 * Add an account, or (`?account=<id>`) sign in again to a signed-out one the
 * person picked. Either way it opens over the account in use, so Cancel
 * returns to it.
 */
export default function AddAccountScreen() {
  const { account: targetId } = useLocalSearchParams<{ account?: string }>();
  const { accounts } = useAccount();
  const target = targetId ? (accounts.find((each) => each.id === targetId) ?? null) : null;
  return (
    <AppThemeProvider>
      <Stack.Screen options={{ headerShown: false, presentation: "modal" }} />
      <SignInScreen
        key={target?.id ?? "new"}
        target={target}
        onDone={() => dismissToHome()}
        onCancel={() => router.back()}
      />
    </AppThemeProvider>
  );
}
