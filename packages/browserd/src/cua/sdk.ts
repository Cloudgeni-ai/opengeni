import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { InteractionControllerError } from "@opengeni/interaction";
import { UnsettledCleanupError } from "../cleanup-error";
import { linuxWorkerLauncher, ownLinuxWorkerGroup } from "./linux-worker";

const compiled = /^(?:\/\$bunfs\/|B:[\\/]~BUN[\\/])/i.test(import.meta.path);

/** The X11 libraries CUA's Linux SDK and worker link against, with their
 * Debian and Ubuntu packages. glibc and libgcc are assumed to exist. */
const LINUX_CUA_LIBRARIES: Readonly<Record<string, string>> = {
  "libX11.so.6": "libx11-6",
  "libXi.so.6": "libxi6",
  "libxkbcommon.so.0": "libxkbcommon0",
};

/**
 * The dynamic loader reports only the first library it can't find, deep in an
 * SDK or worker startup error. Turn that into a plain, actionable failure that
 * names the library and every package CUA needs, so one install fixes it.
 */
export function missingLinuxLibraryError(error: unknown): InteractionControllerError | null {
  const texts: string[] = [];
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    texts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  const missing = [
    ...new Set(
      texts.flatMap((text) =>
        [...text.matchAll(/([\w+.-]+\.so(?:\.\d+)*): cannot open shared object file/g)].map(
          (match) => match[1]!,
        ),
      ),
    ),
  ];
  if (missing.length === 0) return null;
  const listed =
    missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
  return new InteractionControllerError(
    "resource_unavailable",
    `this machine can't start computer use because the system ${
      missing.length === 1 ? "library" : "libraries"
    } ${listed} can't be loaded. Computer use on Linux needs libX11, libXi and libxkbcommon. On Debian or Ubuntu, install with: sudo apt install ${Object.values(
      LINUX_CUA_LIBRARIES,
    ).join(" ")}`,
  );
}

/** Compiled Bun cannot resolve CUA's native packages inside its virtual FS.
 * Releases carry the unmodified SDK bundle and native assets in the same
 * immutable helper generation. No ambient package lookup or runtime download. */
async function loadCuaSdk(): Promise<typeof import("@trycua/cua-driver")> {
  if (!compiled) {
    return await import("@trycua/cua-driver");
  }
  const path = join(dirname(process.execPath), "cua-sdk", "index.js");
  if (!(await Bun.file(path).exists())) {
    throw new Error("This interaction runtime does not contain the experimental CUA SDK");
  }
  const sdk = (await import(pathToFileURL(path).href)) as typeof import("@trycua/cua-driver");
  if (typeof sdk.CuaDriver?.create !== "function") throw new Error("Invalid packaged CUA SDK");
  return sdk;
}

export async function loadCuaDriver() {
  return (await loadCuaSdk()).CuaDriver;
}

/** Use upstream's supervised worker so AppKit owns a main-thread cursor loop.
 * The SDK is only the local transport; desktop behavior comes from the bundled
 * source-built executable. Closing the SDK also closes its private child. */
export async function createCuaRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const { CuaDriver, SessionPermissionMode } = await loadCuaSdk();
  if (process.platform === "win32") return CuaDriver.create(undefined);
  const binaryPath = compiled
    ? join(dirname(process.execPath), "cua-driver")
    : (process.env.OPENGENI_CUA_DRIVER_BINARY ??
      join(import.meta.dir, "../../dist/cua", process.arch, "cua-driver"));
  if (!(await Bun.file(binaryPath).exists()))
    throw new Error("This interaction runtime does not contain the CUA worker");
  const driver = await CuaDriver.createPrivateWorker({
    binaryPath:
      process.platform === "linux"
        ? await linuxWorkerLauncher(binaryPath, environment)
        : binaryPath,
    // Diagnostic attribution only; macOS checks the real host responsibility chain.
    hostBundleId: "ai.opengeni.agent",
    configuredDriver: {
      claudeCodeCompatibility: false,
      authorization: {
        allowedModes: [SessionPermissionMode.Standard],
        compatibilityMode: SessionPermissionMode.Standard,
        unrestrictedAcknowledged: false,
        maxSessionTtlSeconds: 86400n,
        maxIdleTtlSeconds: 3600n,
      },
    },
    // The SDK merges these with its allowed host variables. The Linux launcher
    // unsets alternate display authority after that merge: even an empty
    // WAYLAND_DISPLAY selects Wayland in some native libraries.
    environment: [
      ...Object.entries(environment)
        .filter(
          ([name, value]) =>
            value !== undefined &&
            /^(HOME|DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|XDG_SESSION_TYPE|TMPDIR)$/.test(
              name,
            ),
        )
        .map(([name, value]) => ({ name, value: value! })),
      { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" },
    ],
    inheritStderr: false,
  });
  const destroy = () => {
    if ("uniffiDestroy" in driver && typeof driver.uniffiDestroy === "function")
      driver.uniffiDestroy();
  };
  if (process.platform !== "linux") return driver;
  let stopGroup: () => Promise<void>;
  try {
    stopGroup = await ownLinuxWorkerGroup((await driver.metadata()).pid);
  } catch (error) {
    try {
      await driver.shutdown();
    } catch (cleanupError) {
      throw new UnsettledCleanupError(
        [error, cleanupError],
        "CUA worker startup cleanup did not settle",
      );
    } finally {
      destroy();
    }
    throw error;
  }
  return {
    listToolsJson: () => driver.listToolsJson(),
    callTool: (name: string, args: string) => driver.callTool(name, args),
    metadata: () => driver.metadata(),
    async shutdown() {
      try {
        await driver.shutdown();
      } finally {
        await stopGroup();
      }
    },
    uniffiDestroy: destroy,
  };
}
