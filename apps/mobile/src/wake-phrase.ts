import Constants from "expo-constants";

/** The name Siri knows the call shortcut by: the app's own name ("Talk to Opengeni"). */
export function callAssistantName(): string {
  return Constants.expoConfig?.name?.trim() || "Opengeni";
}
