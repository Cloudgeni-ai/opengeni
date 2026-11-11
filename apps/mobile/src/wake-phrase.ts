import Constants from "expo-constants";

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
