import {
  NativeAgentCallProvider,
  useNativeAgentCall,
  type NativeAgentCallContextValue,
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
import { resolveOutsideCallTarget } from "./call-routing";

export function useAgentCall(): NativeAgentCallContextValue {
  return useNativeAgentCall();
}

const webrtc = createReactNativeWebRtcAdapter();

/**
 * Where a call from outside the app goes (Phone recents, Siri, the Control
 * Center control, the home-screen action, the opengeni://call link): the
 * a fresh session by default. Explicit saved latest/pinned preferences remain
 * in force, and explicit session entry always wins.
 */
async function resolveOutsideCall(context: NativeOutsideCallContext): Promise<string> {
  const opened = getLastOpenedSessionId(context.workspaceId);
  return resolveOutsideCallTarget(context, {
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
  const { client, workspaceId, models } = useAccount();
  const callAdapter = useMemo(() => createExpoCallAdapter(), []);
  useEffect(() => (callAdapter ? connectCallAudioToWebRtc(callAdapter) : undefined), [callAdapter]);
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
      workspaceId={workspaceId}
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
