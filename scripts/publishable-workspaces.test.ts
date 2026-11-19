import { describe, expect, test } from "bun:test";
import {
  OPENGENI_CLI_PACKAGE_NAME,
  isPublishedPackageName,
  npmTarballStem,
  publishableWorkspacePackages,
  publishedPackageOfSpecifier,
} from "./publishable-workspaces";

describe("published package names", () => {
  test("admit the @opengeni scope and only the exact unscoped opengeni CLI", () => {
    for (const name of ["@opengeni/sdk", "@opengeni/vaults-keeper", OPENGENI_CLI_PACKAGE_NAME]) {
      expect(isPublishedPackageName(name)).toBe(true);
    }
    for (const name of [
      "opengeni-web",
      "opengeni2",
      "react",
      "@opengeni/",
      "@opengeni/Sdk",
      "@opengeni/a_b",
      "@opengeni/a.b",
      "@opengeni/-sdk",
      "@opengeni/sdk/artifacts",
      "@other/opengeni",
      "opengeni/sub",
      "",
      undefined,
      42,
    ]) {
      expect(isPublishedPackageName(name)).toBe(false);
    }
  });

  test("map module specifiers to their published package", () => {
    expect(publishedPackageOfSpecifier("@opengeni/sdk")).toBe("@opengeni/sdk");
    expect(publishedPackageOfSpecifier("@opengeni/sdk/artifacts")).toBe("@opengeni/sdk");
    expect(publishedPackageOfSpecifier("opengeni")).toBe("opengeni");
    expect(publishedPackageOfSpecifier("opengeni/package.json")).toBe("opengeni");
    for (const specifier of ["opengeni-web", "react", "./opengeni", "node:fs"]) {
      expect(publishedPackageOfSpecifier(specifier)).toBeNull();
    }
  });

  test("name npm tarballs without their scope", () => {
    expect(npmTarballStem("@opengeni/sdk")).toBe("sdk");
    expect(npmTarballStem("opengeni")).toBe("opengeni");
  });

  test("the publishable workspace set includes the opengeni CLI package", () => {
    const cli = publishableWorkspacePackages().find(
      (pkg) => pkg.name === OPENGENI_CLI_PACKAGE_NAME,
    );
    expect(cli?.dir).toBe("packages/cli");
    expect(publishableWorkspacePackages().map((pkg) => pkg.name)).not.toContain("opengeni-web");
  });
});
