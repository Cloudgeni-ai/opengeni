import sdk from "../../sdk/package.json";
import react from "../../react/package.json";
import codemode from "../../codemode/package.json";
import ogtool from "../../ogtool/package.json";

/** Stable releases use their source manifests. Canary deployments explicitly
 * pin the immutable versions produced by their package publication. */
export function sitePackageVersions(override = process.env.OPENGENI_SITE_PACKAGE_VERSIONS) {
  const defaults = {
    "@opengeni/sdk": sdk.version,
    "@opengeni/react": react.version,
    "@opengeni/codemode": codemode.version,
    "@opengeni/ogtool": ogtool.version,
  };
  if (!override) return defaults;
  const parsed = JSON.parse(override);
  const names = Object.keys(defaults);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== names.length ||
    names.some(
      (name) =>
        typeof parsed[name] !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(parsed[name]),
    )
  ) {
    throw new Error(
      "OPENGENI_SITE_PACKAGE_VERSIONS must pin exact SDK, React, Codemode and ogtool versions",
    );
  }
  return parsed as typeof defaults;
}
