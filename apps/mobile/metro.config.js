// Metro for the OpenGeni native app.
//
// `@opengeni/*` packages are resolved from this repository's workspace sources, so the app
// always runs the checked-out SDK, hooks and native kit: the native kit is resolved directly
// and its workspace dependencies through its own (isolated) node_modules. React-family
// modules always resolve from this app, so linked packages never load a second React.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const appRoot = __dirname;
const repoRoot = path.resolve(appRoot, "../..");
const nativeKitRoot = path.join(repoRoot, "packages/react-native");
const nativeKitOrigin = path.join(nativeKitRoot, "package.json");
const nativeKitExports = require(nativeKitOrigin).exports;
const appOrigin = path.join(appRoot, "package.json");
const singletons = /^(react|react-native|react-dom|scheduler)(\/.*)?$/;
const nativeKit = /^@opengeni\/react-native(?:\/(.+))?$/;

const config = getDefaultConfig(appRoot);
config.watchFolders = [
  appRoot,
  path.join(repoRoot, "packages"),
  path.join(repoRoot, "node_modules"),
];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // tsconfig `paths` are type-only here (Metro's tsconfig-paths support is disabled in
  // app.json); the app alias is resolved explicitly.
  if (moduleName.startsWith("@/")) {
    return context.resolveRequest(context, path.join(appRoot, "src", moduleName.slice(2)), platform);
  }
  const kit = nativeKit.exec(moduleName);
  if (kit) {
    const entry = nativeKitExports[kit[1] ? `./${kit[1]}` : "."];
    if (!entry) throw new Error(`@opengeni/react-native does not export ${moduleName}`);
    return { type: "sourceFile", filePath: path.join(nativeKitRoot, entry.default) };
  }
  if (moduleName.startsWith("@opengeni/")) {
    return context.resolveRequest({ ...context, originModulePath: nativeKitOrigin }, moduleName, platform);
  }
  if (singletons.test(moduleName) && !context.originModulePath.startsWith(appRoot)) {
    return context.resolveRequest({ ...context, originModulePath: appOrigin }, moduleName, platform);
  }
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (error) {
    // Native/Expo modules used by workspace packages are installed by this app.
    if (context.originModulePath.startsWith(appRoot)) throw error;
    return context.resolveRequest({ ...context, originModulePath: appOrigin }, moduleName, platform);
  }
};

module.exports = config;