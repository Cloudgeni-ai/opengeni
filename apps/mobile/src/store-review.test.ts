import { expect, mock, test } from "bun:test";

mock.module("expo-application", () => ({ applicationId: "ai.opengeni.ios" }));
mock.module("react-native", () => ({ Alert: {}, Linking: {} }));

const { canOpenLabRoutes } = await import("./store-review");

test("fixture routes are blocked only in release builds of the public iOS app", () => {
  expect(canOpenLabRoutes(true)).toBe(true);
  expect(canOpenLabRoutes(false)).toBe(false);
  expect(canOpenLabRoutes(false, "ai.opengeni.app")).toBe(true);
  expect(canOpenLabRoutes(false, "com.example.other-app")).toBe(true);
});
