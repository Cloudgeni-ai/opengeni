import { expect, test } from "bun:test";
import { sitePackageVersions } from "../src/site-package-versions";

test("deployment package pins are exact and complete", () => {
  const pins = {
    "@opengeni/sdk": "3.7.1-canary.2",
    "@opengeni/react": "3.7.2",
    "@opengeni/codemode": "0.4.28",
    "@opengeni/ogtool": "0.3.31",
  };
  expect(sitePackageVersions(JSON.stringify(pins))).toEqual(pins);
  for (const version of ["latest", "canary", "^3.7.0", "file:/tmp/sdk.tgz", "3.7.0; echo bad"]) {
    expect(() =>
      sitePackageVersions(JSON.stringify({ ...pins, "@opengeni/sdk": version })),
    ).toThrow();
  }
  expect(() => sitePackageVersions("{}")).toThrow();
});
