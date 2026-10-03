import { expect, test } from "bun:test";
import { sdkCompatUsesNativeFixture } from "./sdk-compat";

test("the old-SDK launcher accepts the explicit shared-harness native fixture", () => {
  expect(
    sdkCompatUsesNativeFixture({
      OPENGENI_TEST_PG_URL: "postgres://postgres:x@127.0.0.1:61440/postgres",
      OPENGENI_REQUIRE_REAL_DB: "1",
    }),
  ).toBe(true);
});

test("missing or blank native configuration still requires Docker", () => {
  expect(sdkCompatUsesNativeFixture({})).toBe(false);
  expect(sdkCompatUsesNativeFixture({ OPENGENI_TEST_PG_URL: " \t " })).toBe(false);
  expect(sdkCompatUsesNativeFixture({ OPENGENI_REQUIRE_REAL_DB: "1" })).toBe(false);
});
