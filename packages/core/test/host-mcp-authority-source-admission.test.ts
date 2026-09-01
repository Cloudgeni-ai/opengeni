import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { assertHostMcpAuthoritySourceAdmissionEnabled } from "../src";

describe("host MCP authority-source admission", () => {
  const hostRef = {
    authoritySource: "host" as const,
    connectionId: "opaque-host-binding",
    providerDomain: "host.example.test",
  };

  test("rejects new explicit host authority before fleet activation", () => {
    expect(() => assertHostMcpAuthoritySourceAdmissionEnabled(testSettings(), hostRef)).toThrow(
      /OPENGENI_HOST_MCP_AUTHORITY_SOURCE_ADMISSION_ENABLED=true/,
    );
  });

  test("admits new explicit host authority after activation and leaves legacy refs alone", () => {
    expect(() =>
      assertHostMcpAuthoritySourceAdmissionEnabled(
        testSettings({ hostMcpAuthoritySourceAdmissionEnabled: true }),
        hostRef,
      ),
    ).not.toThrow();
    expect(() =>
      assertHostMcpAuthoritySourceAdmissionEnabled(testSettings(), {
        connectionId: "legacy-host-binding",
        providerDomain: "host.example.test",
      }),
    ).not.toThrow();
  });
});
