/** npm package name used by deployment BOMs and custom-rig bootstrap hints. */
export const OGTOOL_PACKAGE_NAME = "@opengeni/ogtool" as const;

/** Environment variables consumed by the standalone bundled CLI. */
export const OGTOOL_ENVIRONMENT = {
  url: "OPENGENI_CODEMODE_URL",
  tokenFile: "OPENGENI_CODEMODE_TOKEN_FILE",
  packageSpec: "OPENGENI_OGTOOL_PACKAGE_SPEC",
} as const;

export * from "@opengeni/codemode";
