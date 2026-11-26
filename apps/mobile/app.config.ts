import type { ConfigContext, ExpoConfig } from "expo/config";

const appStoreBundleId = "ai.opengeni.ios";

// First-party data collected by the native client and its hosted service. Review the
// archive's SDK manifests and deployed services separately when filing App Privacy.
const appPrivacyData = [
  "Name",
  "EmailAddress",
  "UserID",
  "DeviceID",
  "OtherUserContent",
  "PhotosorVideos",
  "AudioData",
  "CustomerSupport",
  "OtherDiagnosticData",
  "ProductInteraction",
].map((type) => ({
  NSPrivacyCollectedDataType: `NSPrivacyCollectedDataType${type}`,
  NSPrivacyCollectedDataTypeLinked: true,
  NSPrivacyCollectedDataTypeTracking: false,
  NSPrivacyCollectedDataTypePurposes: [
    "NSPrivacyCollectedDataTypePurposeAppFunctionality",
    ...(type === "ProductInteraction" ? ["NSPrivacyCollectedDataTypePurposeAnalytics"] : []),
  ],
}));

/**
 * Android push needs the Firebase project's client file (google-services.json).
 * It belongs to whoever ships the build, so builds point at it with
 * OPENGENI_GOOGLE_SERVICES_FILE instead of committing it. Without it the app
 * runs normally and only Android push registration is unavailable.
 */
export function buildExpoConfig(
  config: ConfigContext["config"],
  env: NodeJS.ProcessEnv,
): ExpoConfig {
  const googleServicesFile = env.OPENGENI_GOOGLE_SERVICES_FILE;
  const appStore = env.OPENGENI_IOS_APP_STORE === "1";
  const appleTeamId = env.OPENGENI_IOS_APPLE_TEAM_ID;
  const buildNumber = env.OPENGENI_IOS_BUILD_NUMBER;
  if (appStore && !/^[A-Z0-9]{10}$/.test(appleTeamId ?? "")) {
    throw new Error("Set OPENGENI_IOS_APPLE_TEAM_ID to the distribution team's Apple Team ID.");
  }
  if (appStore && !/^[1-9]\d*$/.test(buildNumber ?? "")) {
    throw new Error("Set OPENGENI_IOS_BUILD_NUMBER to an unused positive App Store build number.");
  }

  return {
    ...config,
    name: config.name ?? "Opengeni",
    slug: config.slug ?? "opengeni",
    ...(appStore && {
      ios: {
        ...config.ios,
        bundleIdentifier: appStoreBundleId,
        appleTeamId,
        buildNumber,
        entitlements: { ...config.ios?.entitlements, "aps-environment": "production" },
        infoPlist: {
          ...config.ios?.infoPlist,
          UIApplicationShortcutItems: [
            {
              UIApplicationShortcutItemType: `${appStoreBundleId}.call`,
              UIApplicationShortcutItemTitle: "Call your agent",
              UIApplicationShortcutItemIconSymbolName: "phone.fill",
            },
          ],
          NSMotionUsageDescription:
            "Opengeni uses motion to detect shakes when you turn on shake to send feedback.",
        },
        privacyManifests: {
          NSPrivacyTracking: false,
          NSPrivacyCollectedDataTypes: appPrivacyData,
          NSPrivacyAccessedAPITypes: [
            // OpenGeniCallCommands stores pending call actions in the app's own UserDefaults.
            {
              NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
              NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
            },
          ],
        },
      },
    }),
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  };
}

export default ({ config }: ConfigContext): ExpoConfig => buildExpoConfig(config, process.env);
