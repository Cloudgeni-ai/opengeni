import { describe, expect, test } from "bun:test";
import { nativeCallbackUrl, nativeDeviceLabel } from "./native-sign-in";

describe("native sign-in page", () => {
  test("navigates only to an app callback", () => {
    expect(nativeCallbackUrl("opengeni://auth/callback")?.toString()).toBe(
      "opengeni://auth/callback",
    );
    expect(nativeCallbackUrl("https://evil.example/auth/callback")).toBeNull();
    expect(nativeCallbackUrl("javascript://auth/callback")).toBeNull();
    expect(nativeCallbackUrl("opengeni://auth/callback/../x")).toBeNull();
    expect(nativeCallbackUrl(undefined)).toBeNull();
  });

  test("names the device the person is allowing", () => {
    expect(nativeDeviceLabel({ device_name: " Ada's iPhone " })).toBe("Ada's iPhone");
    expect(nativeDeviceLabel({ platform: "android" })).toBe("this Android device");
    expect(nativeDeviceLabel({})).toBe("this iPhone or iPad");
  });
});
