import { readFile } from "node:fs/promises";
import { machine, release } from "node:os";

/** User-Agent Client Hints as Chromium reports and accepts them over CDP. */
export type ClientHintsMetadata = {
  brands?: Array<{ brand: string; version: string }>;
  fullVersionList?: Array<{ brand: string; version: string }>;
  fullVersion?: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness?: string;
  wow64?: boolean;
  formFactors?: string[];
};

/** The high-entropy hints an ordinary desktop Chrome derives from its host. */
export type HostClientHints = {
  platformVersion: string;
  architecture: string;
  bitness: string;
};

/**
 * Chrome launched with a custom User-Agent switch keeps its brands and
 * platform but reports every high-entropy hint empty, in script and in
 * Sec-CH-UA-* request headers. An ordinary Chrome never does.
 */
export function hasEmptiedHighEntropyHints(metadata: ClientHintsMetadata): boolean {
  return (
    (metadata.brands?.length ?? 0) > 0 &&
    metadata.platform.length > 0 &&
    metadata.platformVersion.length === 0 &&
    metadata.architecture.length === 0 &&
    (metadata.fullVersionList?.length ?? 0) === 0
  );
}

/**
 * The hints this Chrome reports without the switch: its own brand list with
 * full versions, and the host's platform version and architecture.
 * `browserVersion` is the full version from Browser.getVersion.
 */
export function completeClientHints(
  metadata: ClientHintsMetadata,
  browserVersion: string,
  host: HostClientHints,
): ClientHintsMetadata {
  const major = browserVersion.split(".")[0] ?? "";
  const brands = metadata.brands ?? [];
  return {
    brands,
    // Chrome's own brands carry its full version; the GREASE brand pads its
    // major version, for example "24.0.0.0".
    fullVersionList: brands.map(({ brand, version }) => ({
      brand,
      version: version === major ? browserVersion : `${version}.0.0.0`,
    })),
    fullVersion: browserVersion,
    platform: metadata.platform,
    platformVersion: host.platformVersion,
    architecture: host.architecture,
    model: "",
    mobile: false,
    bitness: host.bitness,
    wow64: false,
    formFactors: ["Desktop"],
  };
}

/** This machine's hints, reported the way Chrome derives them. Null on an
 * operating system or processor Chrome's values cannot be derived for. */
export async function hostClientHints(
  probes: {
    platform?: NodeJS.Platform;
    machine?: () => string;
    release?: () => string;
    macosProductVersion?: () => Promise<string>;
  } = {},
): Promise<HostClientHints | null> {
  const cpu = (probes.machine ?? machine)().toLowerCase();
  const architecture = /^(arm|aarch)/u.test(cpu)
    ? "arm"
    : /^(x86_64|amd64|i[3-6]86|x86)$/u.test(cpu)
      ? "x86"
      : null;
  if (!architecture) return null;
  const bitness = cpu.includes("64") ? "64" : "32";
  const platform = probes.platform ?? process.platform;
  let version: string;
  if (platform === "darwin") {
    version = await (probes.macosProductVersion ?? macosProductVersion)();
  } else if (platform === "linux") {
    version = (probes.release ?? release)();
  } else {
    return null;
  }
  const numbers = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u.exec(version);
  if (!numbers) return null;
  const platformVersion = [numbers[1], numbers[2] ?? "0", numbers[3] ?? "0"].join(".");
  return { platformVersion, architecture, bitness };
}

async function macosProductVersion(): Promise<string> {
  const plist = await readFile("/System/Library/CoreServices/SystemVersion.plist", "utf8");
  return /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist)?.[1] ?? "";
}
