import { expect, test } from "bun:test";
import { buildExpoConfig } from "./app.config";
import app from "./app.json";

const store = {
  OPENGENI_IOS_APP_STORE: "1",
  OPENGENI_IOS_APPLE_TEAM_ID: "ABCDE12345",
  OPENGENI_IOS_BUILD_NUMBER: "23",
};

test("only an explicit iOS store build changes the native configuration", () => {
  const { OPENGENI_IOS_APP_STORE: _, ...credentials } = store;
  const config = buildExpoConfig(app.expo, credentials);
  expect(config.ios).toEqual(app.expo.ios);
  expect(config.plugins).toEqual(app.expo.plugins);

  const production = buildExpoConfig(app.expo, store);
  expect(production.version).toBe(app.expo.version);
  expect(production.ios).toMatchObject({
    bundleIdentifier: "ai.opengeni.app",
    appleTeamId: "ABCDE12345",
    buildNumber: "23",
    entitlements: {
      "aps-environment": "production",
      "com.apple.developer.usernotifications.time-sensitive": true,
    },
  });
  expect(production.android).toEqual(app.expo.android);
  expect(production.ios?.privacyManifests?.NSPrivacyAccessedAPITypes).toHaveLength(1);
  expect(production.ios?.privacyManifests?.NSPrivacyCollectedDataTypes).toContainEqual({
    NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeAudioData",
    NSPrivacyCollectedDataTypeLinked: true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  });
});

test("a store build requires an explicit team and build number", () => {
  expect(() => buildExpoConfig(app.expo, { ...store, OPENGENI_IOS_APPLE_TEAM_ID: "" })).toThrow(
    "OPENGENI_IOS_APPLE_TEAM_ID",
  );
  expect(() => buildExpoConfig(app.expo, { ...store, OPENGENI_IOS_BUILD_NUMBER: "0" })).toThrow(
    "OPENGENI_IOS_BUILD_NUMBER",
  );
});
