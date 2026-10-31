import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { addAudioImportToInfoPlist, addAudioImportToManifest } =
  require("../plugin/with-audio-import.cjs") as {
    addAudioImportToInfoPlist(
      plist: Record<string, unknown>,
    ): Record<string, unknown>;
    addAudioImportToManifest(manifest: Record<string, unknown>): {
      manifest: {
        application: Array<{ activity: Array<{ "intent-filter": unknown[] }> }>;
      };
    };
  };
const { pluginFeatures } = require("../plugin/call-intents.cjs") as {
  pluginFeatures(props?: Record<string, unknown>): Record<string, boolean>;
};

describe("audio import config plugin", () => {
  test("lets iOS offer the app for audio, beside the apps that own it, once", () => {
    const plist: Record<string, unknown> = {
      CFBundleDocumentTypes: [
        { CFBundleTypeName: "PDF", LSItemContentTypes: ["com.adobe.pdf"] },
      ],
    };
    addAudioImportToInfoPlist(plist);
    addAudioImportToInfoPlist(plist);
    expect(plist.CFBundleDocumentTypes).toEqual([
      { CFBundleTypeName: "PDF", LSItemContentTypes: ["com.adobe.pdf"] },
      {
        CFBundleTypeName: "Audio recording",
        CFBundleTypeRole: "Viewer",
        LSHandlerRank: "Alternate",
        LSItemContentTypes: [
          "public.audio",
          "public.mpeg-4-audio",
          "com.apple.m4a-audio",
        ],
      },
    ]);
    expect(plist.LSSupportsOpeningDocumentsInPlace).toBe(false);
  });

  test("adds Open with for audio to the main activity once", () => {
    const launcher = {
      action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
    };
    const manifest = {
      manifest: {
        application: [
          {
            activity: [
              {
                $: { "android:name": ".MainActivity" },
                "intent-filter": [launcher],
              },
            ],
          },
        ],
      },
    };
    addAudioImportToManifest(manifest);
    const filters =
      addAudioImportToManifest(manifest).manifest.application[0]!.activity[0]![
        "intent-filter"
      ];
    expect(filters).toHaveLength(2);
    expect(JSON.stringify(filters[1])).toContain(
      '"android:mimeType":"audio/*"',
    );
  });

  test("asking only for audio import sets up no calls", () => {
    expect(pluginFeatures({ audioImport: true })).toEqual({
      call: false,
      recording: false,
      audioImport: true,
    });
    expect(pluginFeatures()).toMatchObject({ call: true, audioImport: false });
  });
});
