import { expect, test } from "bun:test";
import manifest from "../package.json";
import sdkManifest from "../../sdk/package.json";

test("React retains native conversation surfaces without the separate chat export", async () => {
  expect(Object.hasOwn(manifest.exports, "./chat")).toBe(false);
  expect(await Bun.file(new URL("../src/chat.tsx", import.meta.url)).exists()).toBe(false);
  const exports = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  expect(exports).toContain("SessionConversation");
  expect(exports).toContain("MessageTimeline");
  expect(exports).toContain("ChatComposer");
  expect(Object.hasOwn(sdkManifest.exports, "./chat")).toBe(true);
});