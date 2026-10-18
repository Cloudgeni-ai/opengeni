#!/usr/bin/env bun
/**
 * Keep the image browser engines on the current stable release.
 *
 * The images pin exact artifacts so builds are reproducible: Google Chrome by
 * its .deb URL and SHA-256 (desktop image, amd64), and Debian Chromium by
 * package version from one retained debian-security snapshot (sandbox image on
 * every architecture, desktop image on arm64). Exact pins never move by
 * themselves, so this script resolves the newest stable release of each,
 * verifies it, and rewrites the pins.
 *
 *   bun scripts/browser-engine-pins.ts            rewrite the pins when newer releases exist
 *   bun scripts/browser-engine-pins.ts --check    exit 1 when a newer release exists
 *   bun scripts/browser-engine-pins.ts --describe print the pins the checkout holds
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CHROME_REPOSITORY = "https://dl.google.com/linux/chrome/deb";
const DEBIAN_SECURITY = "https://deb.debian.org/debian-security";
const SNAPSHOT = "https://snapshot.debian.org";
const SUITE = "trixie-security";
const ARCHITECTURES = ["amd64", "arm64"] as const;
const CHROMIUM_PACKAGES = ["chromium", "chromium-common"] as const;

const DESKTOP_DOCKERFILE = "docker/desktop.Dockerfile";
const SANDBOX_DOCKERFILE = "docker/sandbox.Dockerfile";
const CONTRACT_TEST = "scripts/browserd-image-build-contract.test.ts";

const CHROME_ADD =
  /ADD --checksum=sha256:([0-9a-f]{64}) https:\/\/dl\.google\.com\/linux\/chrome\/deb\/pool\/main\/g\/google-chrome-stable\/google-chrome-stable_([0-9.]+-[0-9]+)_amd64\.deb \/google-chrome-stable\.deb/g;
const CHROMIUM_VERSION_ARG = /OPENGENI_CHROMIUM_VERSION=([0-9][0-9A-Za-z.+~-]*)/g;
const SNAPSHOT_ARG = /OPENGENI_DEBIAN_SECURITY_SNAPSHOT=([0-9]{8}T[0-9]{6}Z)/g;

export type ChromePin = { version: string; sha256: string };
export type ChromiumPin = { version: string; snapshot: string };

/** Parse a Debian Packages index into one field map per stanza. */
export function parsePackages(index: string): Array<Record<string, string>> {
  return index
    .split(/\n\s*\n/u)
    .map((stanza) => {
      const fields: Record<string, string> = {};
      for (const line of stanza.split("\n")) {
        const match = /^([A-Za-z0-9-]+): ?(.*)$/u.exec(line);
        if (match) fields[match[1]!] = match[2]!;
      }
      return fields;
    })
    .filter((fields) => fields.Package !== undefined);
}

/** Debian version ordering (dpkg --compare-versions), enough for these packages. */
export function compareDebianVersions(left: string, right: string): number {
  const split = (version: string) => {
    const epochEnd = version.indexOf(":");
    const epoch = epochEnd >= 0 ? Number(version.slice(0, epochEnd)) : 0;
    const rest = epochEnd >= 0 ? version.slice(epochEnd + 1) : version;
    const revisionStart = rest.lastIndexOf("-");
    return {
      epoch,
      upstream: revisionStart >= 0 ? rest.slice(0, revisionStart) : rest,
      revision: revisionStart >= 0 ? rest.slice(revisionStart + 1) : "0",
    };
  };
  const order = (character: string | undefined) => {
    if (character === undefined) return 0;
    if (character === "~") return -1;
    if (/[A-Za-z]/u.test(character)) return character.charCodeAt(0);
    return character.charCodeAt(0) + 256;
  };
  const comparePart = (a: string, b: string): number => {
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      while ((i < a.length && !/[0-9]/u.test(a[i]!)) || (j < b.length && !/[0-9]/u.test(b[j]!))) {
        const ca = i < a.length && !/[0-9]/u.test(a[i]!) ? a[i] : undefined;
        const cb = j < b.length && !/[0-9]/u.test(b[j]!) ? b[j] : undefined;
        const difference = order(ca) - order(cb);
        if (difference !== 0) return difference;
        if (ca !== undefined) i += 1;
        if (cb !== undefined) j += 1;
        if (ca === undefined && cb === undefined) break;
      }
      let na = "";
      let nb = "";
      while (i < a.length && /[0-9]/u.test(a[i]!)) na += a[i++];
      while (j < b.length && /[0-9]/u.test(b[j]!)) nb += b[j++];
      const difference = Number(na || "0") - Number(nb || "0");
      if (difference !== 0) return difference;
    }
    return 0;
  };
  const a = split(left);
  const b = split(right);
  return (
    a.epoch - b.epoch || comparePart(a.upstream, b.upstream) || comparePart(a.revision, b.revision)
  );
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return await response.text();
}

async function fetchXzText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  const unpacked = Bun.spawnSync(["xz", "-dc"], {
    stdin: new Uint8Array(await response.arrayBuffer()),
  });
  if (unpacked.exitCode !== 0) throw new Error(`Could not decompress ${url}`);
  return unpacked.stdout.toString();
}

/** Newest google-chrome-stable .deb, with its SHA-256 verified against the downloaded bytes. */
export async function resolveChromePin(): Promise<ChromePin> {
  const index = parsePackages(
    await fetchText(`${CHROME_REPOSITORY}/dists/stable/main/binary-amd64/Packages`),
  ).filter((fields) => fields.Package === "google-chrome-stable");
  const newest = index.sort((a, b) => compareDebianVersions(b.Version!, a.Version!))[0];
  if (!newest?.Version || !newest.SHA256 || !newest.Filename) {
    throw new Error("The Chrome repository lists no google-chrome-stable package");
  }
  const response = await fetch(`${CHROME_REPOSITORY}/${newest.Filename}`);
  if (!response.ok) throw new Error(`Chrome ${newest.Version} download failed`);
  const digest = createHash("sha256")
    .update(new Uint8Array(await response.arrayBuffer()))
    .digest("hex");
  if (digest !== newest.SHA256) {
    throw new Error(`Chrome ${newest.Version} SHA-256 does not match the repository index`);
  }
  return { version: newest.Version, sha256: digest };
}

function chromiumVersions(index: string): Map<string, string[]> {
  const versions = new Map<string, string[]>();
  for (const fields of parsePackages(index)) {
    if (!CHROMIUM_PACKAGES.includes(fields.Package as (typeof CHROMIUM_PACKAGES)[number])) continue;
    versions.set(fields.Package!, [...(versions.get(fields.Package!) ?? []), fields.Version!]);
  }
  return versions;
}

/**
 * Newest Debian security Chromium and the earliest retained snapshot that
 * holds it, with both packages, on every image architecture.
 */
export async function resolveChromiumPin(): Promise<ChromiumPin> {
  const current = chromiumVersions(
    await fetchXzText(`${DEBIAN_SECURITY}/dists/${SUITE}/main/binary-amd64/Packages.xz`),
  );
  const version = (current.get("chromium") ?? []).sort((a, b) => compareDebianVersions(b, a))[0];
  if (!version) throw new Error(`${SUITE} lists no chromium package`);

  const seen: string[] = [];
  for (const pkg of CHROMIUM_PACKAGES) {
    const info = (await (
      await fetch(
        `${SNAPSHOT}/mr/package/chromium/${encodeURIComponent(version)}/binfiles/${pkg}/${encodeURIComponent(version)}?fileinfo=1`,
      )
    ).json()) as {
      result?: Array<{ architecture: string; hash: string }>;
      fileinfo?: Record<string, Array<{ archive_name: string; first_seen: string }>>;
    };
    for (const architecture of ARCHITECTURES) {
      const file = info.result?.find((entry) => entry.architecture === architecture);
      const firstSeen = (file ? (info.fileinfo?.[file.hash] ?? []) : [])
        .filter((entry) => entry.archive_name === "debian-security")
        .map((entry) => entry.first_seen)
        .sort()[0];
      if (!firstSeen) {
        throw new Error(
          `snapshot.debian.org has not retained ${pkg} ${version} for ${architecture}`,
        );
      }
      seen.push(firstSeen);
    }
  }
  const snapshot = seen.sort().at(-1)!;
  for (const architecture of ARCHITECTURES) {
    const listed = chromiumVersions(
      await fetchXzText(
        `${SNAPSHOT}/archive/debian-security/${snapshot}/dists/${SUITE}/main/binary-${architecture}/Packages.xz`,
      ),
    );
    for (const pkg of CHROMIUM_PACKAGES) {
      if (!listed.get(pkg)?.includes(version)) {
        throw new Error(`Snapshot ${snapshot} does not list ${pkg} ${version} for ${architecture}`);
      }
    }
  }
  return { version, snapshot };
}

function only(values: Iterable<string>, label: string): string {
  const unique = [...new Set(values)];
  if (unique.length !== 1)
    throw new Error(`Expected one ${label}, found ${unique.join(", ") || "none"}`);
  return unique[0]!;
}

/** The pins the repository holds now. */
export function currentPins(files: Record<string, string>): {
  chrome: ChromePin;
  chromium: ChromiumPin;
} {
  const desktop = files[DESKTOP_DOCKERFILE]!;
  const dockerfiles = [desktop, files[SANDBOX_DOCKERFILE]!];
  const chromeMatches = [...desktop.matchAll(CHROME_ADD)];
  return {
    chrome: {
      version: only(
        chromeMatches.map((match) => match[2]!),
        "Chrome version",
      ),
      sha256: only(
        chromeMatches.map((match) => match[1]!),
        "Chrome checksum",
      ),
    },
    chromium: {
      version: only(
        dockerfiles.flatMap((text) => [...text.matchAll(CHROMIUM_VERSION_ARG)].map((m) => m[1]!)),
        "Chromium version",
      ),
      snapshot: only(
        dockerfiles.flatMap((text) => [...text.matchAll(SNAPSHOT_ARG)].map((m) => m[1]!)),
        "Debian security snapshot",
      ),
    },
  };
}

/** Rewrite every pin (Dockerfiles and the image contract test) to the given releases. */
export function rewritePins(
  files: Record<string, string>,
  next: { chrome: ChromePin; chromium: ChromiumPin },
): Record<string, string> {
  const current = currentPins(files);
  const replace = (text: string) =>
    text
      .replaceAll(current.chrome.sha256, next.chrome.sha256)
      .replaceAll(
        `google-chrome-stable_${current.chrome.version}_amd64.deb`,
        `google-chrome-stable_${next.chrome.version}_amd64.deb`,
      )
      .replaceAll(
        `OPENGENI_CHROMIUM_VERSION=${current.chromium.version}`,
        `OPENGENI_CHROMIUM_VERSION=${next.chromium.version}`,
      )
      .replaceAll(
        `OPENGENI_DEBIAN_SECURITY_SNAPSHOT=${current.chromium.snapshot}`,
        `OPENGENI_DEBIAN_SECURITY_SNAPSHOT=${next.chromium.snapshot}`,
      );
  return Object.fromEntries(Object.entries(files).map(([path, text]) => [path, replace(text)]));
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const paths = [DESKTOP_DOCKERFILE, SANDBOX_DOCKERFILE, CONTRACT_TEST];
  const files = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, await readFile(resolve(ROOT, path), "utf8")] as const),
    ),
  );
  const current = currentPins(files);
  if (process.argv.includes("--describe")) {
    console.log(
      `Google Chrome ${current.chrome.version} (desktop image, amd64); ` +
        `Debian Chromium ${current.chromium.version} from debian-security snapshot ${current.chromium.snapshot}.`,
    );
    return;
  }
  const [chrome, chromium] = await Promise.all([resolveChromePin(), resolveChromiumPin()]);
  const chromeNewer = compareDebianVersions(chrome.version, current.chrome.version) > 0;
  const chromiumNewer = compareDebianVersions(chromium.version, current.chromium.version) > 0;
  const next = {
    chrome: chromeNewer ? chrome : current.chrome,
    chromium: chromiumNewer ? chromium : current.chromium,
  };
  console.log(
    `Chrome ${current.chrome.version} -> ${next.chrome.version}; ` +
      `Chromium ${current.chromium.version} (${current.chromium.snapshot}) -> ` +
      `${next.chromium.version} (${next.chromium.snapshot})`,
  );
  if (!chromeNewer && !chromiumNewer) return;
  if (check) {
    process.exitCode = 1;
    return;
  }
  const rewritten = rewritePins(files, next);
  for (const path of paths) {
    if (rewritten[path] !== files[path]) await writeFile(resolve(ROOT, path), rewritten[path]!);
  }
}

if (import.meta.main) await main();
