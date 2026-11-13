import { expect, test } from "bun:test";
import { NATIVE_PUSH_UNAVAILABLE_DETAIL_CODE as contractsCode } from "@opengeni/contracts";
import {
  NATIVE_PUSH_UNAVAILABLE_DETAIL_CODE,
  OpenGeniApiError,
  isNativePushUnavailableError,
} from "../src";

test("the SDK's push-unavailable code matches the API's", () => {
  expect(NATIVE_PUSH_UNAVAILABLE_DETAIL_CODE).toBe(contractsCode);
});

test("a refused push registration is recognized by its detail code", () => {
  const refused = new OpenGeniApiError(
    409,
    JSON.stringify({
      error: {
        code: "conflict",
        message: "This server can't send notifications to this app.",
        retryable: false,
        details: { code: NATIVE_PUSH_UNAVAILABLE_DETAIL_CODE },
      },
    }),
  );
  expect(isNativePushUnavailableError(refused)).toBe(true);
  expect(isNativePushUnavailableError(new OpenGeniApiError(409, "{}"))).toBe(false);
  expect(isNativePushUnavailableError(new Error("x"))).toBe(false);
});
