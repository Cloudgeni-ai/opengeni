import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceAuthorization } from "@opengeni/react/connect";
import { SubscriptionDeviceCodePanel } from "./subscription-device-code-panel";

for (const provider of ["codex", "supergrok"] as const) {
  test(`${provider} native presentation retains URL validation`, () => {
    for (const verificationUri of [
      "javascript:alert(1)",
      "https://user:password@example.com",
      "invalid",
    ]) {
      const html = renderToStaticMarkup(
        <SubscriptionDeviceCodePanel
          provider={provider}
          userCode="ABCD-1234"
          verificationUri={verificationUri}
        />,
      );
      expect(html).not.toContain("href=");
      expect(html).toContain("Authorization address unavailable.");
      expect(html).toContain('role="alert"');
      expect(html).toContain("ABCD-1234");
      expect(html).toContain('aria-label="Copy code"');
    }
  });
}

test("embedded device presentation remains available without a native renderer", () => {
  const html = renderToStaticMarkup(
    <DeviceAuthorization userCode="HOST-1234" verificationUri="https://example.com/device" />,
  );
  expect(html).toContain('class="og-connect ');
  expect(html).toContain("Enter this code at the provider.");
  expect(html).toContain('href="https://example.com/device"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('role="status"');
  expect(html).not.toContain("<svg");
});
