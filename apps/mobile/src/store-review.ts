import * as Application from "expo-application";
import { Alert, Linking } from "react-native";

export function isPublicIosApp(): boolean {
  return Application.applicationId === "ai.opengeni.ios";
}

export function openOpengeniPrivacyPolicy(): void {
  void Linking.openURL("https://opengeni.ai/privacy").catch(() => {
    Alert.alert("Couldn't open the privacy policy", "Visit opengeni.ai/privacy in your browser.");
  });
}
