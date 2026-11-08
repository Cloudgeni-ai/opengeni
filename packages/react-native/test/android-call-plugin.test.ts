import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type Entry = { $: Record<string, string>; "intent-filter"?: unknown[] };
type Manifest = {
  manifest: {
    "uses-permission": Entry[];
    application: Array<{
      $: Record<string, string>;
      "meta-data": Entry[];
      service: Entry[];
      receiver: Entry[];
      activity: Entry[];
    }>;
  };
};
const plugin = require("../plugin/with-android-call.cjs") as {
  addSystemCallToManifest(manifest: unknown, options: { push: boolean }): Manifest;
  SERVICE: string;
  RECEIVER: string;
  ACTIVITY: string;
  MESSAGING_SERVICE: string;
  META_ENABLED: string;
};

const names = (entries: Entry[]) => entries.map((entry) => entry.$["android:name"]);

function appManifest() {
  return {
    manifest: {
      "uses-permission": [{ $: { "android:name": "android.permission.RECORD_AUDIO" } }],
      application: [
        {
          $: { "android:name": ".MainApplication" },
          activity: [{ $: { "android:name": ".MainActivity" } }],
        },
      ],
    },
  };
}

describe("Android system call config plugin", () => {
  test("declares the call's permissions, service, ring screen and flag once", () => {
    const manifest = appManifest();
    plugin.addSystemCallToManifest(manifest, { push: true });
    const result = plugin.addSystemCallToManifest(manifest, { push: true }).manifest;
    expect(names(result["uses-permission"])).toEqual([
      "android.permission.RECORD_AUDIO",
      "android.permission.MANAGE_OWN_CALLS",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_PHONE_CALL",
      "android.permission.FOREGROUND_SERVICE_MICROPHONE",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.USE_FULL_SCREEN_INTENT",
    ]);
    const application = result.application[0]!;
    expect(application["meta-data"]).toEqual([
      { $: { "android:name": plugin.META_ENABLED, "android:value": "true" } },
    ]);
    expect(application.service).toEqual([
      {
        $: {
          "android:name": plugin.SERVICE,
          "android:exported": "false",
          "android:foregroundServiceType": "phoneCall|microphone",
        },
      },
      {
        $: { "android:name": plugin.MESSAGING_SERVICE, "android:exported": "false" },
        "intent-filter": [
          { action: [{ $: { "android:name": "com.google.firebase.MESSAGING_EVENT" } }] },
        ],
      },
    ]);
    expect(names(application.receiver)).toEqual([plugin.RECEIVER]);
    expect(names(application.activity)).toEqual([".MainActivity", plugin.ACTIVITY]);
    expect(application.activity[1]!.$).toMatchObject({
      "android:exported": "false",
      "android:showWhenLocked": "true",
      "android:turnScreenOn": "true",
    });
  });

  test("an app without push gets system calls but no ringing", () => {
    const manifest = appManifest();
    plugin.addSystemCallToManifest(manifest, { push: true });
    const result = plugin.addSystemCallToManifest(manifest, { push: false }).manifest;
    expect(names(result.application[0]!.service)).toEqual([plugin.SERVICE]);
  });
});
