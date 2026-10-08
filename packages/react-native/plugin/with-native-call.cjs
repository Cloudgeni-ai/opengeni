// Expo config plugin: system voice calls with the host's agent.
//
// - Info.plist: the background modes CallKit needs (`audio`, `voip`), the
//   INStartCallIntent activity for Phone recents, the microphone purpose, and
//   optional Siri app-name synonyms (for example the agent's own name).
// - An App Intent ("Call <agent>") plus App Shortcuts, generated into the app
//   target, so Siri, Spotlight, the Shortcuts app and the Action button can
//   start a call without any setup. The intent opens the app and hands the
//   request to the same start path as Phone recents and the home-screen action.
// - Optionally (`call.control`), a WidgetKit extension with a "Call <agent>"
//   control for Control Center, the Lock Screen and the Action button.
const fs = require("node:fs");
const path = require("node:path");
const {
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
  IOSConfig,
} = require("expo/config-plugins");

const { SWIFT_FILE, intentsSource, resolveOptions } = require("./call-intents.cjs");
const {
  CONTROL_TARGET,
  CONTROL_SWIFT_FILE,
  CONTROL_INFO_PLIST,
  resolveControl,
  controlSource,
  controlInfoPlist,
  controlBuildSettings,
} = require("./call-control.cjs");

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
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
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
  const control = resolveControl(options.call, config.name);
  if (control) {
    if (!options.appIntents) {
      throw new Error(
        "@opengeni/react-native: call.control needs the generated App Intent; remove call.appIntents: false.",
      );
    }
    config = withCallControl(config, options, control);
  }
  return config;
}

function withCallControl(config, options, control) {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!bundleIdentifier) {
    throw new Error("@opengeni/react-native: call.control needs ios.bundleIdentifier.");
  }
  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      const directory = path.join(mod.modRequest.platformProjectRoot, CONTROL_TARGET);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, CONTROL_SWIFT_FILE),
        controlSource(options.call, control, `${bundleIdentifier}.call-control`),
      );
      fs.writeFileSync(
        path.join(directory, CONTROL_INFO_PLIST),
        controlInfoPlist({
          displayName: control.title,
          version: config.version ?? "1.0.0",
          buildNumber: config.ios?.buildNumber ?? "1",
        }),
      );
      return mod;
    },
  ]);
  return withXcodeProject(config, (mod) => {
    addControlTarget(mod.modResults, {
      bundleIdentifier,
      control,
      developmentTeam: config.ios?.appleTeamId,
    });
    return mod;
  });
}

/** Adds the control extension target once, embedded in the app target. */
function addControlTarget(project, { bundleIdentifier, control, developmentTeam }) {
  const objects = project.hash.project.objects;
  const exists = Object.values(objects.PBXNativeTarget ?? {}).some(
    (target) => typeof target === "object" && unquote(target.name) === CONTROL_TARGET,
  );
  if (exists) return;
  // `addTarget` links the extension to the app through these sections, which a
  // fresh Expo project may not have yet.
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  objects.PBXCopyFilesBuildPhase ??= {};

  const target = project.addTarget(CONTROL_TARGET, "app_extension", CONTROL_TARGET);
  // The group's file references come first so the Sources phase reuses them.
  const group = project.addPbxGroup(
    [CONTROL_SWIFT_FILE, CONTROL_INFO_PLIST],
    CONTROL_TARGET,
    CONTROL_TARGET,
  );
  const mainGroup = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group.uuid, mainGroup);
  project.addBuildPhase([CONTROL_SWIFT_FILE], "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

  // Embed the extension under the name Xcode itself uses.
  for (const [key, phase] of Object.entries(objects.PBXCopyFilesBuildPhase)) {
    if (typeof phase !== "object" || phase.dstSubfolderSpec !== 13) continue;
    if (!phase.files?.some((file) => String(file.comment ?? "").includes(CONTROL_TARGET))) continue;
    phase.name = '"Embed Foundation Extensions"';
    objects.PBXCopyFilesBuildPhase[`${key}_comment`] = "Embed Foundation Extensions";
  }

  const configurations = objects.XCConfigurationList[target.pbxNativeTarget.buildConfigurationList];
  for (const { value } of configurations.buildConfigurations) {
    const configuration = objects.XCBuildConfiguration[value];
    configuration.buildSettings = controlBuildSettings({
      bundleIdentifier,
      control,
      developmentTeam,
      debug: unquote(configuration.name) === "Debug",
    });
  }
}

function unquote(value) {
  return String(value ?? "").replace(/^"(.*)"$/, "$1");
}

module.exports = withNativeCall;
