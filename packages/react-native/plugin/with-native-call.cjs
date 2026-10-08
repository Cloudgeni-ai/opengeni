// Expo config plugin: system voice calls with the host's agent.
//
// - Info.plist: the background modes CallKit needs (`audio`, `voip`), the
//   INStartCallIntent activity for Phone recents, the microphone purpose, and
//   optional Siri app-name synonyms (for example the agent's own name).
// - An App Intent ("Call <agent>") plus App Shortcuts, generated into the app
//   target, so Siri, Spotlight, the Shortcuts app and the Action button can
//   start a call without any setup. The intent opens the app and hands the
//   request to the same start path as Phone recents and the home-screen action.
const fs = require("node:fs");
const path = require("node:path");
const {
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
  IOSConfig,
} = require("expo/config-plugins");

const { SWIFT_FILE, intentsSource, resolveOptions } = require("./call-intents.cjs");

function addUnique(list, values) {
  const next = Array.isArray(list) ? [...list] : [];
  for (const value of values) if (!next.includes(value)) next.push(value);
  return next;
}

function withCallInfoPlist(config, options) {
  return withInfoPlist(config, (mod) => {
    const plist = mod.modResults;
    plist.UIBackgroundModes = addUnique(plist.UIBackgroundModes, ["audio", "voip"]);
    plist.NSUserActivityTypes = addUnique(plist.NSUserActivityTypes, ["INStartCallIntent"]);
    if (!plist.NSMicrophoneUsageDescription) {
      plist.NSMicrophoneUsageDescription = options.microphonePermission;
    }
    if (options.alternativeAppNames.length > 0) {
      const existing = Array.isArray(plist.INAlternativeAppNames)
        ? plist.INAlternativeAppNames
        : [];
      const names = new Set(existing.map((entry) => entry.INAlternativeAppName));
      plist.INAlternativeAppNames = [
        ...existing,
        ...options.alternativeAppNames
          .filter((name) => !names.has(name))
          .map((name) => ({ INAlternativeAppName: name })),
      ];
    }
    return mod;
  });
}

function withCallIntentsSource(config, options) {
  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const projectName = mod.modRequest.projectName;
      const directory = path.join(mod.modRequest.platformProjectRoot, projectName);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, SWIFT_FILE), intentsSource(options.call));
      return mod;
    },
  ]);
  return withXcodeProject(config, (mod) => {
    const projectName = mod.modRequest.projectName;
    const filepath = `${projectName}/${SWIFT_FILE}`;
    if (!mod.modResults.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFile({
        filepath,
        groupName: projectName,
        project: mod.modResults,
      });
    }
    return mod;
  });
}

function withNativeCall(config, props) {
  const options = resolveOptions(props);
  config = withCallInfoPlist(config, options);
  if (options.appIntents) config = withCallIntentsSource(config, options);
  return config;
}

module.exports = withNativeCall;
