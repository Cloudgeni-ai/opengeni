import { wakePhraseSetupAvailable } from "@opengeni/react-native";
import Constants from "expo-constants";

/**
 * Whether the app offers the "Hey Opengeni" setup (the SDK's `WakePhraseGuide`
 * on the wake-phrase screen). Hidden for now: set it to `true` to show the
 * Settings row and the voice command's "Set up “Hey …”" row again.
 */
const OFFER_WAKE_PHRASE_SETUP = false;

/** Whether to show the "Hey Opengeni" setup on this phone. */
export function offerWakePhraseSetup(): boolean {
  return OFFER_WAKE_PHRASE_SETUP && wakePhraseSetupAvailable();
}

/** The name Siri knows the call shortcut by: the app's own name ("Talk to Opengeni"). */
export function callAssistantName(): string {
  return Constants.expoConfig?.name?.trim() || "Opengeni";
}

/**
 * What to say to Siri for a voice command: the first of the call plugin's
 * `chatPhrases` in app.json ("Call {chat} in {app}").
 */
export function voiceCommandRequest(name: string): string {
  return `Call ${name} in ${callAssistantName()}`;
}
