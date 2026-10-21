import { expect, test } from "bun:test";
import {
  completeClientHints,
  hasEmptiedHighEntropyHints,
  hostClientHints,
} from "../src/client-hints";

const switched = {
  brands: [
    { brand: "Google Chrome", version: "155" },
    { brand: "Chromium", version: "155" },
    { brand: "Not(A:Brand", version: "24" },
  ],
  fullVersionList: [],
  platform: "macOS",
  platformVersion: "",
  architecture: "",
  model: "",
  mobile: false,
  bitness: "",
  wow64: false,
  formFactors: [],
};

test("recognizes only the hints a User-Agent switch empties", () => {
  expect(hasEmptiedHighEntropyHints(switched)).toBe(true);
  expect(hasEmptiedHighEntropyHints({ ...switched, platformVersion: "26.2.0" })).toBe(false);
  expect(hasEmptiedHighEntropyHints({ ...switched, brands: [] })).toBe(false);
});

test("completes the hints as the same Chrome reports them without the switch", () => {
  expect(
    completeClientHints(switched, "155.0.8059.82", {
      platformVersion: "26.2.0",
      architecture: "arm",
      bitness: "64",
    }),
  ).toEqual({
    brands: switched.brands,
    fullVersionList: [
      { brand: "Google Chrome", version: "155.0.8059.82" },
      { brand: "Chromium", version: "155.0.8059.82" },
      { brand: "Not(A:Brand", version: "24.0.0.0" },
    ],
    fullVersion: "155.0.8059.82",
    platform: "macOS",
    platformVersion: "26.2.0",
    architecture: "arm",
    model: "",
    mobile: false,
    bitness: "64",
    wow64: false,
    formFactors: ["Desktop"],
  });
});

test("derives host hints the way Chrome does", async () => {
  expect(
    await hostClientHints({
      platform: "darwin",
      machine: () => "arm64",
      macosProductVersion: async () => "26.2",
    }),
  ).toEqual({ platformVersion: "26.2.0", architecture: "arm", bitness: "64" });
  expect(
    await hostClientHints({
      platform: "linux",
      machine: () => "x86_64",
      release: () => "6.12.48-generic",
    }),
  ).toEqual({ platformVersion: "6.12.48", architecture: "x86", bitness: "64" });
  expect(
    await hostClientHints({ platform: "linux", machine: () => "aarch64", release: () => "6.8" }),
  ).toEqual({ platformVersion: "6.8.0", architecture: "arm", bitness: "64" });
  expect(
    await hostClientHints({ platform: "linux", machine: () => "riscv64", release: () => "6.8" }),
  ).toBeNull();
  expect(
    await hostClientHints({ platform: "win32", machine: () => "x86_64", release: () => "10" }),
  ).toBeNull();
});
