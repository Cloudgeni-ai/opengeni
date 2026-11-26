import * as Application from "expo-application";
import { Alert, Linking } from "react-native";

export function isPublicIosApp(applicationId = Application.applicationId): boolean {
  return applicationId === "ai.opengeni.ios";
}

export function canOpenLabRoutes(
  development: boolean,
  applicationId = Application.applicationId,
): boolean {
  return development || !isPublicIosApp(applicationId);
}

export function openOpengeniPrivacyPolicy(): void {
  void Linking.openURL("https://opengeni.ai/privacy").catch(() => {
    Alert.alert("Couldn't open the privacy policy", "Visit opengeni.ai/privacy in your browser.");
  });
}
