import { expect, test } from "bun:test";
import { BrowserTarget } from "@opengeni/contracts";
import { restoredTabUrl } from "../src/restored-tab-url";

test.each([
  "https://example.test/account?tab=1",
  "about:blank",
  "chrome://settings/",
  "data:text/plain,retained",
])("preserves navigable saved URL %s", (url) => expect(restoredTabUrl(url)).toBe(url));

test.each(["blob:https://example.test/1234", "chrome-error://chromewebdata/"])(
  "retains a visible, inert explanation for %s across repeated checkpoints",
  (url) => {
    const restored = restoredTabUrl(url);
    const html = Buffer.from(restored.split(",")[1]!, "base64").toString();
    expect(html).toContain("Tab could not be restored");
    expect(html).toContain(url);
    expect(html).toContain("default-src 'none'");
    expect(restoredTabUrl(restored)).toBe(restored);
  },
);

test("untrusted long URLs cannot inject active markup or exceed the target URL contract", () => {
  const restored = restoredTabUrl(
    'blob:https://example.test/<script>fetch("https://bad.test")</script>' + "&".repeat(16_000),
  );
  const html = Buffer.from(restored.split(",")[1]!, "base64").toString();
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("[URL shortened]");
  expect(BrowserTarget.shape.url.safeParse(restored).success).toBe(true);
});
