// Expo config plugin, `recording: true`: meeting and site-walk recording that
// keeps going in the background.
//
// - Android: the microphone permission and the foreground service, with the
//   microphone type, that keeps capture alive with the screen off. Declared
//   only on request, because Play asks every app with a microphone
//   foreground service to justify it. Also the notification permission:
//   Android 13 and later hide the service's ongoing notification without it.
// - Android: Auto Backup rules that leave recordings not uploaded yet
//   (files/opengeni-recordings) out of cloud backups and device transfers.
//   They back up shared preferences only, as expo-secure-store's own rules
//   do, and keep its SecureStore preferences out too; an app with backup
//   rules of its own keeps them. iOS marks the folder itself as excluded
//   from backup at runtime.
// - iOS: the `audio` background mode, which the call plugin also adds.
const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod, withInfoPlist } = require("expo/config-plugins");

const SERVICE = "dev.opengeni.audiocapture.OpenGeniAudioCaptureService";
const PERMISSIONS = [
  "android.permission.RECORD_AUDIO",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  "android.permission.POST_NOTIFICATIONS",
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

const BACKUP_RULES = "opengeni_backup_rules";
const DATA_EXTRACTION_RULES = "opengeni_data_extraction_rules";
// expo-secure-store's rules, which ours replace with the same and more.
const REPLACEABLE_RULES = new Set([
  "@xml/secure_store_backup_rules",
  "@xml/secure_store_data_extraction_rules",
]);

// Only what is included is backed up, so files/opengeni-recordings is not.
// (An exclude outside every included path is a fatal lint error.)
const BACKED_UP = `    <include domain="sharedpref" path="."/>
    <exclude domain="sharedpref" path="SecureStore"/>`;

/** Auto Backup rules for Android 11 and lower. */
const backupRulesXml = () => `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
${BACKED_UP.replace(/^ {2}/gmu, "")}
</full-backup-content>
`;

/** Auto Backup and device-transfer rules for Android 12 and higher. */
const dataExtractionRulesXml = () => `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
${BACKED_UP}
  </cloud-backup>
  <device-transfer>
${BACKED_UP}
  </device-transfer>
</data-extraction-rules>
`;

/**
 * Point the app at the recording-safe backup rules, unless it set rules of
 * its own (other than expo-secure-store's). True when they were applied.
 */
function addRecordingBackupRulesToManifest(manifest) {
  const root = manifest.manifest;
  root.application ??= [{ $: { "android:name": ".MainApplication" } }];
  const application = root.application[0];
  application.$ ??= {};
  const current = [
    application.$["android:fullBackupContent"],
    application.$["android:dataExtractionRules"],
  ];
  if (application.$["android:allowBackup"] === "false") return false;
  const ours = [`@xml/${BACKUP_RULES}`, `@xml/${DATA_EXTRACTION_RULES}`];
  if (current.some((value) => value && !ours.includes(value) && !REPLACEABLE_RULES.has(value))) {
    console.warn(
      "@opengeni/react-native: the app has Android backup rules of its own; exclude files/opengeni-recordings from them so recordings not uploaded yet stay off backups.",
    );
    return false;
  }
  application.$["android:fullBackupContent"] = ours[0];
  application.$["android:dataExtractionRules"] = ours[1];
  return true;
}

function withRecording(config) {
  config = withAndroidManifest(config, (mod) => {
    addRecordingToManifest(mod.modResults);
    addRecordingBackupRulesToManifest(mod.modResults);
    return mod;
  });
  config = withDangerousMod(config, [
    "android",
    (mod) => {
      const directory = path.join(mod.modRequest.platformProjectRoot, "app/src/main/res/xml");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, `${BACKUP_RULES}.xml`), backupRulesXml());
      fs.writeFileSync(
        path.join(directory, `${DATA_EXTRACTION_RULES}.xml`),
        dataExtractionRulesXml(),
      );
      return mod;
    },
  ]);
  return withInfoPlist(config, (mod) => {
    const modes = Array.isArray(mod.modResults.UIBackgroundModes)
      ? mod.modResults.UIBackgroundModes
      : [];
    if (!modes.includes("audio")) modes.push("audio");
    mod.modResults.UIBackgroundModes = modes;
    return mod;
  });
}

module.exports = {
  withRecording,
  addRecordingToManifest,
  addRecordingBackupRulesToManifest,
  backupRulesXml,
  dataExtractionRulesXml,
  SERVICE,
};
