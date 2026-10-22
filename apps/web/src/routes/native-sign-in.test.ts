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

  test("hands the Office add-in's code only to its callback page on this origin", () => {
    const origin = "https://app.example.com";
    expect(
      nativeCallbackUrl("https://app.example.com/office/auth-callback.html", origin)?.toString(),
    ).toBe("https://app.example.com/office/auth-callback.html");
    expect(
      nativeCallbackUrl("https://evil.example.com/office/auth-callback.html", origin),
    ).toBeNull();
    expect(
      nativeCallbackUrl("https://app.example.com/office/auth-callback.html?x=1", origin),
    ).toBeNull();
    expect(nativeCallbackUrl("https://app.example.com/office/index.html", origin)).toBeNull();
  });

  test("names the device the person is allowing", () => {
    expect(nativeDeviceLabel({ device_name: " Ada's iPhone " })).toBe("Ada's iPhone");
    expect(nativeDeviceLabel({ platform: "android" })).toBe("this Android device");
    expect(nativeDeviceLabel({ platform: "macos" })).toBe("this Mac");
    expect(nativeDeviceLabel({ platform: "linux" })).toBe("this computer");
    expect(nativeDeviceLabel({ platform: "office" })).toBe("the Opengeni add-in in Excel");
    expect(nativeDeviceLabel({})).toBe("this iPhone or iPad");
  });
});
