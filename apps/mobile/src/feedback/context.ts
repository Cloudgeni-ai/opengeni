import type { FeedbackContext } from "@opengeni/sdk";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { recentErrors } from "./recent-errors";

const text = (value: string | null | undefined, max: number): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

function intl(): { locale?: string; timeZone?: string } {
  try {
    const options = Intl.DateTimeFormat().resolvedOptions();
    return { locale: text(options.locale, 35), timeZone: text(options.timeZone, 64) };
  } catch {
    return {};
  }
}

/** App, build and device facts needed to reproduce a report, plus recent errors. */
export function collectFeedbackContext(input: {
  trigger: "menu" | "shake";
  screen: string | null;
}): FeedbackContext {
  const { locale, timeZone } = intl();
  const errors = recentErrors();
  const context: FeedbackContext = {
    source: "mobile",
    trigger: input.trigger,
    platform: Platform.OS,
    appVersion: text(Application.nativeApplicationVersion ?? Constants.expoConfig?.version, 64),
    buildNumber: text(Application.nativeBuildVersion, 64),
    osVersion: text(`${Device.osName ?? Platform.OS} ${Device.osVersion ?? ""}`, 64),
    deviceModel: text(Device.modelName, 120),
    screen: text(input.screen, 500),
    locale,
    timeZone,
    recentErrors: errors.length ? [...errors] : undefined,
  };
  // Absent facts are left out rather than sent empty.
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as FeedbackContext;
}
