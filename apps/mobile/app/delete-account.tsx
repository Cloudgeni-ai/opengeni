import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import * as Crypto from "expo-crypto";
import { Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useAccount, usePickAccount } from "@/account";
import {
  ACCOUNT_DELETION_STARTED_COPY,
  accountDeletionApi,
  accountDeletionFailure,
  type AccountDeletionApi,
  type AccountDeletionFailure,
  type AccountDeletionPreview,
} from "@/account-deletion";
import { deleteAccountSections } from "@/account-deletion-settings";
import { dismissToHome } from "@/navigation";
import { SettingsList } from "@/settings-list";
import { AppThemeProvider } from "@/theme";
import { openOnWeb, webPaths } from "@/web-links";

export default function DeleteAccountScreen() {
  return (
    <AppThemeProvider>
      <DeleteAccount />
    </AppThemeProvider>
  );
}

type Screen =
  | { kind: "loading" }
  | { kind: "failed"; failure: AccountDeletionFailure }
  | { kind: "ready"; preview: AccountDeletionPreview }
  /** Deletion started; this device has forgotten the account. */
  | { kind: "started" };

/** Android's Done (iOS draws a system bar button). */
function DoneButton() {
  const c = useNativeTimelineTheme().colors;
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={8}
      onPress={dismissToHome}
      style={{ paddingHorizontal: 4 }}
    >
      <Text style={{ color: c.fg, fontSize: 17, fontWeight: "600" }}>Done</Text>
    </Pressable>
  );
}

/*
 * Delete the signed-in account: what closes with it and what the person
 * leaves, anything that must change first (an organization only they own),
 * then DELETE typed in full. Once the server takes it, every session is
 * revoked, so the app forgets the account here and says what happens next.
 */
export function DeleteAccount({ lab }: { lab?: AccountDeletionApi }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { account, client, workspaces, signOut } = useAccount();
  const pickAccount = usePickAccount();
  const api = useMemo(() => lab ?? accountDeletionApi(client), [client, lab]);
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // One request however often it's retried: the server treats a repeat as the same deletion.
  const [operationId] = useState(() => Crypto.randomUUID());

  const load = useCallback(async () => {
    try {
      const preview = await api.read();
      setScreen({ kind: "ready", preview });
    } catch (caught) {
      setScreen({ kind: "failed", failure: accountDeletionFailure(caught) });
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const baseUrl = account?.baseUrl ?? null;
  const manageMembers = (organizationId: string) => {
    const workspace = workspaces.find((each) => each.accountId === organizationId);
    if (!baseUrl || !workspace) return null;
    return () => openOnWeb(baseUrl, webPaths.organizationMembers(workspace.id));
  };

  const submit = async () => {
    if (screen.kind !== "ready" || !account) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.request(operationId);
    } catch (caught) {
      const failure = accountDeletionFailure(caught);
      setSubmitting(false);
      if (failure.kind === "blocked") {
        // Show what blocks it now; the server's list is the current one.
        setScreen({
          kind: "ready",
          preview: {
            ...screen.preview,
            blockers: failure.blockers.length ? failure.blockers : screen.preview.blockers,
          },
        });
        setSubmitError(failure.message);
      } else if (failure.kind === "signedOut") {
        setScreen({ kind: "failed", failure });
      } else {
        setSubmitError(failure.message);
      }
      return;
    }
    // Every session is revoked now, this one too: forget the account here.
    setScreen({ kind: "started" });
    await signOut(account.id, { askAboutRecordings: false }).catch(() => false);
  };

  const header = (title: string, options: { done?: boolean } = {}) => (
    <Stack.Screen
      options={{
        title,
        headerTintColor: c.fg,
        headerShadowVisible: false,
        headerStyle: { backgroundColor: c.bg },
        ...(options.done
          ? {
              headerBackVisible: false,
              gestureEnabled: false,
              ...(Platform.OS === "ios"
                ? {
                    unstable_headerRightItems: () => [
                      {
                        type: "button" as const,
                        label: "Done",
                        accessibilityLabel: "Done",
                        onPress: dismissToHome,
                      },
                    ],
                  }
                : { headerRight: DoneButton }),
            }
          : {}),
      }}
    />
  );

  if (screen.kind === "started") {
    return (
      <>
        {header("", { done: true })}
        <SettingsList
          sections={[]}
          empty={{
            title: "Your account is being deleted",
            description: ACCOUNT_DELETION_STARTED_COPY,
            symbol: "checkmark.circle",
          }}
        />
      </>
    );
  }
  if (screen.kind === "loading") {
    return (
      <>
        {header("Delete account")}
        <View
          style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}
        >
          <ActivityIndicator />
        </View>
      </>
    );
  }
  if (screen.kind === "failed") {
    const { failure } = screen;
    return (
      <>
        {header("Delete account")}
        <SettingsList
          sections={[
            {
              id: "failed",
              footer: failure.message,
              rows:
                failure.kind === "signedOut" && account
                  ? [
                      {
                        kind: "action",
                        id: "sign-in",
                        title: "Sign in again",
                        symbol: "person.crop.circle",
                        onPress: () => pickAccount(account.id),
                      },
                    ]
                  : failure.kind === "unavailable"
                    ? []
                    : [
                        {
                          kind: "action",
                          id: "retry",
                          title: "Try again",
                          symbol: "arrow.clockwise",
                          onPress: () => {
                            setScreen({ kind: "loading" });
                            void load();
                          },
                        },
                      ],
            },
          ]}
        />
      </>
    );
  }
  return (
    <>
      {header("Delete account")}
      <SettingsList
        sections={deleteAccountSections(screen.preview, {
          typed,
          onType: setTyped,
          submitting,
          error: submitError,
          manageMembers,
          checkAgain: () => void load(),
          submit: () => void submit(),
        })}
        onRefresh={load}
      />
    </>
  );
}
