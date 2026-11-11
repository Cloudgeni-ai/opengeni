// The extension version has one owner: `package.json`, which Changesets bumps
// in the Version PR. The source manifest deliberately omits `version`; every
// packaged manifest (unpacked archive and store ZIP) is stamped from it.

type Manifest = Record<string, unknown>;

const CHROME_VERSION = /^\d{1,5}(\.\d{1,5}){0,3}$/;

export function packagedManifest(source: Manifest, packageVersion: unknown): Manifest {
  if ("version" in source) {
    throw new Error("manifest.json must not declare version; package.json owns it");
  }
  if (typeof packageVersion !== "string" || !CHROME_VERSION.test(packageVersion)) {
    throw new Error(`package.json version is not a Chrome extension version: ${packageVersion}`);
  }
  const { manifest_version, name, short_name, description, ...rest } = source;
  return { manifest_version, name, short_name, description, version: packageVersion, ...rest };
}

export function storeManifest(manifest: Manifest): Manifest {
  // The Web Store assigns its own identity and rejects a development `key`.
  const { key: _key, ...store } = manifest;
  return store;
}
