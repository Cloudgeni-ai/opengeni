import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type Entry = { $: Record<string, string>; "intent-filter"?: unknown[] };
type Manifest = {
  manifest: {
    $: Record<string, string>;
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
  addSystemCallToManifest(
    manifest: unknown,
    options: { push: boolean; messagingService?: "opengeni" | "app" },
  ): Manifest;
  resolveAndroidMessagingService(call?: Record<string, unknown>): "opengeni" | "app";
  SERVICE: string;
  RECEIVER: string;
  ACTIVITY: string;
  MESSAGING_SERVICE: string;
  META_ENABLED: string;
  META_APP_MESSAGING_SERVICE: string;
};
const withNativeCall = require("../plugin/with-native-call.cjs") as (
  config: Record<string, unknown>,
  props: Record<string, unknown>,
) => unknown;

const names = (entries: Entry[]) => entries.map((entry) => entry.$["android:name"]);

function appManifest(service: Entry[] = []) {
  return {
    manifest: {
      "uses-permission": [{ $: { "android:name": "android.permission.RECORD_AUDIO" } }],
      application: [
        {
          $: { "android:name": ".MainApplication" },
          activity: [{ $: { "android:name": ".MainActivity" } }],
          service,
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
        $: {
          "android:name": plugin.MESSAGING_SERVICE,
          "android:exported": "false",
          "tools:ignore": "Instantiatable",
        },
        "intent-filter": [
          { action: [{ $: { "android:name": "com.google.firebase.MESSAGING_EVENT" } }] },
        ],
      },
    ]);
    expect(result.$["xmlns:tools"]).toBe("http://schemas.android.com/tools");
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
    expect(names(result.application[0]!["meta-data"])).toEqual([plugin.META_ENABLED]);
  });
});

describe("Android rings through the app's own messaging service", () => {
  test("declares no messaging service and flags the app's own, keeping the call setup", () => {
    const manifest = appManifest();
    plugin.addSystemCallToManifest(manifest, { push: true, messagingService: "app" });
    const result = plugin.addSystemCallToManifest(manifest, {
      push: true,
      messagingService: "app",
    }).manifest;
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
      { $: { "android:name": plugin.META_APP_MESSAGING_SERVICE, "android:value": "true" } },
    ]);
    expect(application.service).toEqual([
      {
        $: {
          "android:name": plugin.SERVICE,
          "android:exported": "false",
          "android:foregroundServiceType": "phoneCall|microphone",
        },
      },
    ]);
    expect(names(application.receiver)).toEqual([plugin.RECEIVER]);
    expect(names(application.activity)).toEqual([".MainActivity", plugin.ACTIVITY]);
  });

  test("switching modes replaces the other mode's entries, keeping the app's own", () => {
    const manifest = appManifest([
      { $: { "android:name": ".AppMessagingService", "android:exported": "false" } },
    ]);
    plugin.addSystemCallToManifest(manifest, { push: true });
    let application = plugin.addSystemCallToManifest(manifest, {
      push: true,
      messagingService: "app",
    }).manifest.application[0]!;
    expect(names(application.service)).toEqual([".AppMessagingService", plugin.SERVICE]);
    expect(names(application["meta-data"])).toContain(plugin.META_APP_MESSAGING_SERVICE);

    application = plugin.addSystemCallToManifest(manifest, { push: true }).manifest.application[0]!;
    expect(names(application.service)).toEqual([
      ".AppMessagingService",
      plugin.SERVICE,
      plugin.MESSAGING_SERVICE,
    ]);
    expect(names(application["meta-data"])).toEqual([plugin.META_ENABLED]);
  });

  test("the option defaults to Opengeni's service and accepts only the two modes", () => {
    expect(plugin.resolveAndroidMessagingService()).toBe("opengeni");
    expect(plugin.resolveAndroidMessagingService({ androidSystemCall: true })).toBe("opengeni");
    expect(
      plugin.resolveAndroidMessagingService({
        androidSystemCall: true,
        androidMessagingService: "opengeni",
      }),
    ).toBe("opengeni");
    expect(
      plugin.resolveAndroidMessagingService({
        androidSystemCall: true,
        androidMessagingService: "app",
      }),
    ).toBe("app");
    expect(() =>
      plugin.resolveAndroidMessagingService({
        androidSystemCall: true,
        androidMessagingService: "firebase",
      }),
    ).toThrow('must be "opengeni" or "app"');
    // Without system calls nothing rings, so "app" would silently do nothing.
    expect(() => plugin.resolveAndroidMessagingService({ androidMessagingService: "app" })).toThrow(
      "needs call.androidSystemCall: true",
    );
  });

  test("the config plugin rejects a misspelled mode before any platform runs", () => {
    expect(() =>
      withNativeCall(
        { name: "App" },
        { call: { androidSystemCall: true, androidMessagingService: "App" } },
      ),
    ).toThrow('must be "opengeni" or "app"');
  });

  test("the native module counts the flag the plugin writes as rings being available", () => {
    // No Android toolchain runs in these tests: hold the Kotlin side to the
    // same meta-data name, and to availability through either service.
    const source = readFileSync(
      new URL("../android/src/main/java/dev/opengeni/call/OpenGeniCallPush.kt", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      `const val META_APP_MESSAGING_SERVICE = "${plugin.META_APP_MESSAGING_SERVICE}"`,
    );
    expect(source).toContain(`private const val SERVICE = "${plugin.MESSAGING_SERVICE}"`);
    expect(source).toMatch(
      /fun available\(context: Context\): Boolean = declaresService\(context\) \|\| appDeliversRings\(context\)/,
    );
    expect(source).toMatch(/getBoolean\(META_APP_MESSAGING_SERVICE, false\)/);
    // The public entry point the app's own service calls, from Kotlin or Java.
    expect(source).toMatch(
      /@JvmStatic\n\s+fun handle\(context: Context, data: Map<String, String>\): Boolean/,
    );
  });
});
