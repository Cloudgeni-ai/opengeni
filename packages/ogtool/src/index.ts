/** npm package name used by deployment BOMs and custom-rig bootstrap hints. */
export const OGTOOL_PACKAGE_NAME = "@opengeni/ogtool" as const;

/** Environment variables consumed by the dependency-free CLI. */
export const OGTOOL_ENVIRONMENT = {
  url: "OPENGENI_TOOLSPACE_URL",
  tokenFile: "OPENGENI_TOOLSPACE_TOKEN_FILE",
  packageSpec: "OPENGENI_OGTOOL_PACKAGE_SPEC",
} as const;
