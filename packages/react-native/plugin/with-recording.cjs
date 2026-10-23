// Expo config plugin, `recording: true`: meeting and site-walk recording that
// keeps going in the background.
//
// - Android: the microphone permission and the foreground service, with the
//   microphone type, that keeps capture alive with the screen off. Declared
//   only on request, because Play asks every app with a microphone
//   foreground service to justify it.
// - iOS: the `audio` background mode, which the call plugin also adds.
const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

const SERVICE = "dev.opengeni.audiocapture.OpenGeniAudioCaptureService";
const PERMISSIONS = [
  "android.permission.RECORD_AUDIO",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
];

/** Add the recording permissions and service to a parsed AndroidManifest.xml. */
function addRecordingToManifest(manifest) {
  const root = manifest.manifest;
  root["uses-permission"] ??= [];
  for (const name of PERMISSIONS) {
    if (!root["uses-permission"].some((entry) => entry.$?.["android:name"] === name)) {
      root["uses-permission"].push({ $: { "android:name": name } });
    }
  }
  root.application ??= [{ $: { "android:name": ".MainApplication" } }];
  const application = root.application[0];
  application.service ??= [];
  if (!application.service.some((entry) => entry.$?.["android:name"] === SERVICE)) {
    application.service.push({
      $: {
        "android:name": SERVICE,
        "android:exported": "false",
        "android:foregroundServiceType": "microphone",
      },
    });
  }
  return manifest;
}

function withRecording(config) {
  config = withAndroidManifest(config, (mod) => {
    addRecordingToManifest(mod.modResults);
    return mod;
  });
  return withInfoPlist(config, (mod) => {
    const modes = Array.isArray(mod.modResults.UIBackgroundModes)
      ? mod.modResults.UIBackgroundModes
      : [];
    if (!modes.includes("audio")) modes.push("audio");
    mod.modResults.UIBackgroundModes = modes;
    return mod;
  });
}

module.exports = { withRecording, addRecordingToManifest, SERVICE };
