import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { addRecordingToManifest, SERVICE } = require("../plugin/with-recording.cjs") as {
  addRecordingToManifest(manifest: Record<string, unknown>): {
    manifest: {
      "uses-permission": Array<{ $: Record<string, string> }>;
      application: Array<{ service: Array<{ $: Record<string, string> }> }>;
    };
  };
  SERVICE: string;
};

describe("recording config plugin", () => {
  test("declares the microphone foreground service and its permissions once", () => {
    const manifest = {
      manifest: {
        "uses-permission": [{ $: { "android:name": "android.permission.RECORD_AUDIO" } }],
        application: [{ $: { "android:name": ".MainApplication" } }],
      },
    };
    addRecordingToManifest(manifest);
    const result = addRecordingToManifest(manifest).manifest;
    expect(result["uses-permission"].map((entry) => entry.$["android:name"])).toEqual([
      "android.permission.RECORD_AUDIO",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_MICROPHONE",
      "android.permission.POST_NOTIFICATIONS",
    ]);
    expect(result.application[0]!.service).toEqual([
      {
        $: {
          "android:name": SERVICE,
          "android:exported": "false",
          "android:foregroundServiceType": "microphone",
        },
      },
    ]);
  });
});
