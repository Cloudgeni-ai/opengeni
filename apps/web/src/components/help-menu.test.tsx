import { describe, expect, test } from "bun:test";

import { documentationLinkFromClientConfig } from "@/lib/documentation-link";

describe("documentation link client config", () => {
  test("uses the deployment's advertised documentation URL", () => {
    expect(
      documentationLinkFromClientConfig({ documentationUrl: "https://docs.opengeni.ai" }),
    ).toBe("https://docs.opengeni.ai/");
    expect(
      documentationLinkFromClientConfig({ documentationUrl: "http://docs.internal.test/opengeni" }),
    ).toBe("http://docs.internal.test/opengeni");
  });

  test("shows no link when the deployment hides it or predates the field", () => {
    expect(documentationLinkFromClientConfig({ documentationUrl: null })).toBeNull();
    expect(documentationLinkFromClientConfig({})).toBeNull();
  });

  test("never turns a non-http(s) value into a link", () => {
    for (const documentationUrl of ["javascript:alert(1)", "data:text/html,x", "/docs", ""]) {
      expect(documentationLinkFromClientConfig({ documentationUrl })).toBeNull();
    }
  });
});
