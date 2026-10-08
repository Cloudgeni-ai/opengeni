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

export function useAgentCall(): NativeAgentCallContextValue {
  return useNativeAgentCall();
}

const webrtc = createReactNativeWebRtcAdapter();

/**
 * Where a call from outside the app goes (Phone recents, Siri, the Control
 * Center control, the home-screen action, the opengeni://call link): the
 * session the user pinned, else the one last opened, else the newest
 * conversation, else a new session; or always a new session.
 */
async function resolveOutsideCall(context: NativeOutsideCallContext): Promise<string> {
  const { requested, workspaceId, sessionExists, latestOrNew, client } = context;
  if (requested) return requested;
  const preference = getOutsideCallTarget();
  const pinned = getPinnedCallSession();
  if (preference === "pinned" && pinned?.workspaceId === workspaceId) {
    if (await sessionExists(pinned.sessionId)) return pinned.sessionId;
    // The chosen session is gone: forget it and start fresh rather than fail the call.
    unpinCallSession();
  }
  if (preference === "latest") {
    // The session you last had open, like calling back whoever you were talking to.
    const opened = getLastOpenedSessionId(workspaceId);
    if (opened) {
      if (await sessionExists(opened)) return opened;
      forgetOpenedSession({ workspaceId, sessionId: opened });
    }
    return latestOrNew();
  }
  const created = await client.createSession(workspaceId, { startMode: "realtime" });
  return created.id;
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
