// Expo config plugin, `audioImport: true`: audio files shared to the app
// become meetings (see `useSharedAudioImport`).
//
// - iOS: the app opens audio documents, so the share sheet of Notes (where
//   the Phone app keeps call recordings), Voice Memos and Files offers it. iOS
//   hands the app a copy in Documents/Inbox.
// - Android: "Open with" for audio files, which hands the app a content link.
const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

const DOCUMENT_TYPE_NAME = "Audio recording";
const AUDIO_CONTENT_TYPES = ["public.audio", "public.mpeg-4-audio", "com.apple.m4a-audio"];

/** Add the audio document type to a parsed Info.plist. */
function addAudioImportToInfoPlist(plist) {
  const types = Array.isArray(plist.CFBundleDocumentTypes) ? plist.CFBundleDocumentTypes : [];
  if (!types.some((entry) => entry.CFBundleTypeName === DOCUMENT_TYPE_NAME)) {
    types.push({
      CFBundleTypeName: DOCUMENT_TYPE_NAME,
      CFBundleTypeRole: "Viewer",
      // Offered beside the apps that own audio, never instead of them.
      LSHandlerRank: "Alternate",
      LSItemContentTypes: AUDIO_CONTENT_TYPES,
    });
  }
  plist.CFBundleDocumentTypes = types;
  // A copy for the app, not the other app's file opened in place.
  plist.LSSupportsOpeningDocumentsInPlace ??= false;
  return plist;
}

const VIEW_AUDIO_FILTER = {
  action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
  category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
  data: [
    { $: { "android:scheme": "content" } },
    { $: { "android:scheme": "file" } },
    { $: { "android:mimeType": "audio/*" } },
  ],
};

function isViewAudioFilter(filter) {
  return (
    filter.action?.some((a) => a.$?.["android:name"] === "android.intent.action.VIEW") &&
    filter.data?.some((d) => d.$?.["android:mimeType"] === "audio/*")
  );
}

/** Add "Open with" for audio to the main activity of a parsed AndroidManifest.xml. */
function addAudioImportToManifest(manifest) {
  const application = manifest.manifest.application?.[0];
  const activity = application?.activity?.find(
    (entry) => entry.$?.["android:name"] === ".MainActivity",
  );
  if (!activity) return manifest;
  activity["intent-filter"] ??= [];
  if (!activity["intent-filter"].some(isViewAudioFilter)) {
    activity["intent-filter"].push(structuredClone(VIEW_AUDIO_FILTER));
  }
  return manifest;
}

function withAudioImport(config) {
  config = withInfoPlist(config, (mod) => {
    addAudioImportToInfoPlist(mod.modResults);
    return mod;
  });
  return withAndroidManifest(config, (mod) => {
    addAudioImportToManifest(mod.modResults);
    return mod;
  });
}

module.exports = {
  withAudioImport,
  addAudioImportToInfoPlist,
  addAudioImportToManifest,
};
