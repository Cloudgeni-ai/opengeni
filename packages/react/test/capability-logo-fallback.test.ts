import { expect, test } from "bun:test";
import { capabilityLogoFallback } from "../src/capability-logo-fallback";

test("embedded catalogues use the original passive logo and preserve suppressed marks", () => {
  expect(
    capabilityLogoFallback({
      id: "service",
      metadata: { originalLogoUrl: "https://logos.example.test/service.svg" },
    }),
  ).toBe("https://logos.example.test/service.svg");
  for (const originalLogoUrl of [null, "javascript:alert(1)", "not a url"]) {
    expect(capabilityLogoFallback({ id: "service", metadata: { originalLogoUrl } })).toBeNull();
  }
});

test("Gmail ships its reviewed logo with the SDK instead of using a host public path", () => {
  const logo = capabilityLogoFallback({
    id: "service",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
  });
  expect(logo).toBeTruthy();
  expect(logo).not.toBe("/capability-logos/gmail.ico");
});
