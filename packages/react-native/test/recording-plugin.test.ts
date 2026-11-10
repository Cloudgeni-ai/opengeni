import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  addRecordingToManifest,
  addRecordingBackupRulesToManifest,
  backupRulesXml,
  dataExtractionRulesXml,
  SERVICE,
} = require("../plugin/with-recording.cjs") as {
  addRecordingBackupRulesToManifest(manifest: {
    manifest: { application?: Array<{ $: Record<string, string> }> };
  }): boolean;
  backupRulesXml(): string;
  dataExtractionRulesXml(): string;
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

  test("keeps unsent recordings off Android backups and device transfers", () => {
    const application = (attributes: Record<string, string>) => ({
      manifest: {
        application: [
          { $: { "android:name": ".MainApplication", ...attributes } as Record<string, string> },
        ],
      },
    });
    const fresh = application({});
    expect(addRecordingBackupRulesToManifest(fresh)).toBe(true);
    expect(fresh.manifest.application[0]!.$).toMatchObject({
      "android:fullBackupContent": "@xml/opengeni_backup_rules",
      "android:dataExtractionRules": "@xml/opengeni_data_extraction_rules",
    });
    // expo-secure-store's rules are replaced by the same rules and more.
    const secureStore = application({
      "android:fullBackupContent": "@xml/secure_store_backup_rules",
      "android:dataExtractionRules": "@xml/secure_store_data_extraction_rules",
    });
    expect(addRecordingBackupRulesToManifest(secureStore)).toBe(true);
    expect(secureStore.manifest.application[0]!.$["android:fullBackupContent"]).toBe(
      "@xml/opengeni_backup_rules",
    );
    // An app's own rules stay; it is told to exclude the folder itself.
    const warn = console.warn;
    console.warn = () => {};
    try {
      const own = application({ "android:fullBackupContent": "@xml/my_rules" });
      expect(addRecordingBackupRulesToManifest(own)).toBe(false);
      expect(own.manifest.application[0]!.$["android:fullBackupContent"]).toBe("@xml/my_rules");
    } finally {
      console.warn = warn;
    }

    for (const xml of [backupRulesXml(), dataExtractionRulesXml()]) {
      // Files, the recordings folder among them, are never included.
      expect(xml).not.toContain('domain="file"');
      expect(xml).not.toContain('domain="root"');
      expect(xml).toContain('<exclude domain="sharedpref" path="SecureStore"/>');
      // Only shared preferences are backed up at all, as with expo-secure-store.
      expect(xml.match(/<include /g)?.length).toBe(xml.includes("cloud-backup") ? 2 : 1);
      expect(xml).toContain('<include domain="sharedpref" path="."/>');
    }
    expect(dataExtractionRulesXml()).toContain("<cloud-backup>");
    expect(dataExtractionRulesXml()).toContain("<device-transfer>");
  });
});
