import { expect, test } from "bun:test";
import manifest from "../package.json";
import sdkManifest from "../../sdk/package.json";

test("React retains native conversation surfaces without the separate chat export", async () => {
  expect(Object.hasOwn(manifest.exports, "./chat")).toBe(false);
  expect(await Bun.file(new URL("../src/chat.tsx", import.meta.url)).exists()).toBe(false);
  const exports = await import("../src/index");
  expect(Object.hasOwn(exports, "SessionConversation")).toBe(true);
  expect(Object.hasOwn(exports, "MessageTimeline")).toBe(true);
  expect(Object.hasOwn(exports, "ChatComposer")).toBe(true);
  expect(Object.hasOwn(sdkManifest.exports, "./chat")).toBe(true);
});
