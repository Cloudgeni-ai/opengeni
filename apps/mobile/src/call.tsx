import {
  NativeAgentCallProvider,
  useNativeAgentCall,
  type NativeAgentCallContextValue,
  type NativeCallAdapter,
  type NativeOutsideCallContext,
} from "@opengeni/react-native";
import { createExpoCallAdapter } from "@opengeni/react-native/expo";
import {
  connectCallAudioToWebRtc,
  createReactNativeWebRtcAdapter,
} from "@opengeni/react-native/webrtc";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useAccount } from "@/account";
import {
  forgetOpenedSession,
  getLastOpenedSessionId,
  getOutsideCallTarget,
  getPinnedCallSession,
  unpinCallSession,
} from "@/call-preferences";
import { AppThemeProvider } from "@/theme";
import { nativeCallCommands } from "@/voice-command-model";
import {
  activateVoiceCommands,
  markVoiceCommandMissing,
  subscribeVoiceCommands,
} from "@/voice-commands";
import { resolveOutsideCallTarget } from "./call-routing";

export function useAgentCall(): NativeAgentCallContextValue {
  return useNativeAgentCall();
}

const webrtc = createReactNativeWebRtcAdapter();

let callAdapterInstance: NativeCallAdapter | null | undefined;
/** The app's one system call integration (CallKit), shared by calls and Settings. */
export function sharedCallAdapter(): NativeCallAdapter | null {
  if (callAdapterInstance === undefined) callAdapterInstance = createExpoCallAdapter();
  return callAdapterInstance;
}

/**
 * Where a call from outside the app goes (Phone recents, Siri, the Control
 * Center control, the home-screen action, the opengeni://call link): the
 * a fresh session by default. Explicit saved latest/pinned preferences remain
 * in force, and explicit session entry always wins.
 */
async function resolveOutsideCall(context: NativeOutsideCallContext): Promise<string> {
  const opened = getLastOpenedSessionId(context.workspaceId);
  return resolveOutsideCallTarget(context, {
    missing: (sessionId) => {
      const command = markVoiceCommandMissing(context.workspaceId, sessionId);
      return new Error(
        command
          ? `The chat for “${command.name}” no longer exists, so this voice command is off. You can remove it in Settings.`
          : "This chat no longer exists.",
      );
    },
    target: getOutsideCallTarget(),
    pinned: getPinnedCallSession(),
    opened,
    unpin: unpinCallSession,
    forgetOpened: () => {
      if (opened) forgetOpenedSession({ workspaceId: context.workspaceId, sessionId: opened });
    },
  });
}

/**
 * One call with an agent at a time, above navigation: it keeps talking while
 * you read the chat, leave the app or lock the phone.
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { client, workspaceId, models, status, account } = useAccount();
  const callAdapter = useMemo(() => sharedCallAdapter(), []);
  useEffect(() => (callAdapter ? connectCallAudioToWebRtc(callAdapter) : undefined), [callAdapter]);
  useVoiceCommandCatalog(
    callAdapter,
    status === "signedOut" ? null : status === "ready" ? (account?.id ?? null) : undefined,
  );
  const codexConnected = models.some(
    (model) => model.provider === "codex" || model.id.startsWith("codex/"),
  );
  const onCallStarting = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, []);
  const renderSurface = useCallback(
    (surface: ReactNode) => <AppThemeProvider>{surface}</AppThemeProvider>,
    [],
  );
  return (
    <NativeAgentCallProvider
      client={client}
      // Calls start once the account can make requests: at launch the saved
      // workspace is known before the sign-in is read, and a call requested
      // from outside (a voice command that opened the app) waits until then.
      workspaceId={status === "ready" ? workspaceId : null}
      codexConnected={codexConnected}
      callAdapter={callAdapter}
      webrtc={webrtc}
      resolveOutsideCall={resolveOutsideCall}
      onCallStarting={onCallStarting}
      renderSurface={renderSurface}
    >
      {children}
    </NativeAgentCallProvider>
  );
}

/**
 * Siri and the launcher offer the signed-in account's voice commands only:
 * switching accounts swaps them, signing out removes them. While the account
 * still loads (`undefined`) the system keeps what it has, so a command that
 * launched the app keeps working.
 */
function useVoiceCommandCatalog(
  adapter: NativeCallAdapter | null,
  accountId: string | null | undefined,
) {
  useEffect(() => {
    if (accountId !== undefined) void activateVoiceCommands(accountId);
  }, [accountId]);
  useEffect(() => {
    const write = adapter?.setCallCommands?.bind(adapter);
    if (!write || accountId === undefined) return;
    let last: string | null = null;
    return subscribeVoiceCommands((loaded) => {
      // Until this account's commands load, the previous account's are still here.
      if (loaded.accountId !== accountId) return;
      const next = nativeCallCommands(loaded.commands);
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      void write(next).catch((error: unknown) => {
        if (__DEV__) console.warn("Couldn't update voice commands", error);
      });
    });
  }, [adapter, accountId]);
}
