// Expo config plugin, `call.androidSystemCall: true`: Android voice calls as
// system calls (self-managed Telecom calls), the Android side of CallKit.
//
// - The permissions a self-managed call needs: managing its own calls, the
//   phone-call foreground service that keeps it going with the screen off,
//   the microphone, notifications, and the full-screen ring screen.
// - The call's foreground service, the notification buttons' receiver and the
//   ring screen shown over the lock screen.
// - When the app uses expo-notifications, the Firebase messaging service that
//   lets agents ring this phone. It hands every other push to
//   expo-notifications, whose own service it takes precedence over.
// - The meta-data flag the module reads to use system calls at all; without
//   it, calls only set up the phone's call audio.
//
// Declared only on request: Play asks apps with a phone-call foreground
// service or full-screen intents to justify them.
const { withAndroidManifest } = require("expo/config-plugins");

const PACKAGE = "dev.opengeni.call";
const SERVICE = `${PACKAGE}.OpenGeniCallService`;
const RECEIVER = `${PACKAGE}.CallActionReceiver`;
const ACTIVITY = `${PACKAGE}.IncomingCallActivity`;
const MESSAGING_SERVICE = `${PACKAGE}.OpenGeniCallMessagingService`;
const META_ENABLED = `${PACKAGE}.SYSTEM_CALLS`;
const PERMISSIONS = [
  "android.permission.MANAGE_OWN_CALLS",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_PHONE_CALL",
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  "android.permission.RECORD_AUDIO",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.USE_FULL_SCREEN_INTENT",
];

function upsert(list, name, entry) {
  const index = list.findIndex((item) => item.$?.["android:name"] === name);
  if (index === -1) list.push(entry);
  else list[index] = entry;
}

/**
 * Add system calls to a parsed AndroidManifest.xml. `push` declares the
 * messaging service that rings agents' calls; it needs expo-notifications.
 */
function addSystemCallToManifest(manifest, { push }) {
  const root = manifest.manifest;
  root["uses-permission"] ??= [];
  for (const name of PERMISSIONS) {
    if (!root["uses-permission"].some((entry) => entry.$?.["android:name"] === name)) {
      root["uses-permission"].push({ $: { "android:name": name } });
    }
  }
  root.application ??= [{ $: { "android:name": ".MainApplication" } }];
  const application = root.application[0];
  application["meta-data"] ??= [];
  upsert(application["meta-data"], META_ENABLED, {
    $: { "android:name": META_ENABLED, "android:value": "true" },
  });
  application.service ??= [];
  upsert(application.service, SERVICE, {
    $: {
      "android:name": SERVICE,
      "android:exported": "false",
      "android:foregroundServiceType": "phoneCall|microphone",
    },
  });
  if (push) {
    upsert(application.service, MESSAGING_SERVICE, {
      $: { "android:name": MESSAGING_SERVICE, "android:exported": "false" },
      "intent-filter": [
        { action: [{ $: { "android:name": "com.google.firebase.MESSAGING_EVENT" } }] },
      ],
    });
  } else {
    application.service = application.service.filter(
      (entry) => entry.$?.["android:name"] !== MESSAGING_SERVICE,
    );
  }
  application.receiver ??= [];
  upsert(application.receiver, RECEIVER, {
    $: { "android:name": RECEIVER, "android:exported": "false" },
  });
  application.activity ??= [];
  upsert(application.activity, ACTIVITY, {
    $: {
      "android:name": ACTIVITY,
      "android:exported": "false",
      "android:showWhenLocked": "true",
      "android:turnScreenOn": "true",
      "android:excludeFromRecents": "true",
      "android:launchMode": "singleTop",
      "android:taskAffinity": "",
      "android:theme": "@android:style/Theme.DeviceDefault.NoActionBar",
    },
  });
  return manifest;
}

/** Whether the app has expo-notifications, which brings Firebase messaging. */
function hasExpoNotifications(projectRoot) {
  try {
    require.resolve("expo-notifications/package.json", { paths: [projectRoot] });
    return true;
  } catch {
    return false;
  }
}

function withAndroidSystemCall(config) {
  return withAndroidManifest(config, (mod) => {
    addSystemCallToManifest(mod.modResults, {
      push: hasExpoNotifications(mod.modRequest.projectRoot),
    });
    return mod;
  });
}

module.exports = {
  withAndroidSystemCall,
  addSystemCallToManifest,
  SERVICE,
  RECEIVER,
  ACTIVITY,
  MESSAGING_SERVICE,
  META_ENABLED,
};
