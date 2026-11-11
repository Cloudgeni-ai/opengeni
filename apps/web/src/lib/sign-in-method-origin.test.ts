import { expect, test } from "bun:test";
import { signInMethodsHaveSameOrigin } from "./sign-in-method-origin";

test("security accepts relative and equivalent absolute API origins", () => {
  for (const api of [
    "",
    "/",
    "/proxy",
    "https://app.example.com",
    "https://app.example.com:443/",
  ]) {
    expect(signInMethodsHaveSameOrigin(api, "https://app.example.com/settings/security")).toBe(
      true,
    );
  }
});

test("security refuses different ports, schemes, hosts and opaque origins", () => {
  for (const api of [
    "https://app.example.com:8443",
    "http://app.example.com",
    "https://api.example.com",
    "//evil.example.com",
    "https://[",
  ]) {
    expect(signInMethodsHaveSameOrigin(api, "https://app.example.com/settings/security")).toBe(
      false,
    );
  }
  expect(signInMethodsHaveSameOrigin("", "about:blank")).toBe(false);
});
