import { describe, expect, test } from "bun:test";

import {
  OPENGENI_BROWSER_EXTENSION_URL,
  browserExtension,
  nativeConnectionCapabilityRecommendations,
} from "../src";

describe("deployment browser extension", () => {
  test("defaults to Opengeni Browser", () => {
    expect(browserExtension({})).toEqual({
      name: "Opengeni Browser",
      installUrl: OPENGENI_BROWSER_EXTENSION_URL,
    });
  });

  test("a deployment's own extension replaces the name and install link", () => {
    const extension = browserExtension({
      browserExtensionName: "Example Browser",
      browserExtensionInstallUrl: "https://chromewebstore.google.com/detail/example/abc",
    });
    expect(extension.name).toBe("Example Browser");
    const machine = nativeConnectionCapabilityRecommendations({
      connectedMachines: true,
      browserExtension: extension,
    }).find((item) => item.id === "api:connected-machine");
    expect(JSON.stringify(machine)).toContain(extension.installUrl);
    expect(JSON.stringify(machine)).not.toContain(OPENGENI_BROWSER_EXTENSION_URL);
  });
});
