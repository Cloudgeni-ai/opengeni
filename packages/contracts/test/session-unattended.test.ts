import { describe, expect, test } from "bun:test";
import {
  CreateSessionRequest,
  SESSION_UNATTENDED_METADATA_KEY,
  sessionMetadataUnattended,
  withSessionUnattendedMetadata,
} from "../src/index";

describe("unattended session create option", () => {
  test("is optional and boolean", () => {
    expect(CreateSessionRequest.parse({ initialMessage: "Run" }).unattended).toBeUndefined();
    expect(CreateSessionRequest.parse({ initialMessage: "Run", unattended: true }).unattended).toBe(
      true,
    );
    expect(() =>
      CreateSessionRequest.parse({ initialMessage: "Run", unattended: "yes" }),
    ).toThrow();
  });

  test("only the explicit option sets the reserved metadata key", () => {
    const supplied = { team: "ops", [SESSION_UNATTENDED_METADATA_KEY]: true };
    expect(withSessionUnattendedMetadata(supplied, false)).toEqual({ team: "ops" });
    expect(withSessionUnattendedMetadata({ team: "ops" }, true)).toEqual(supplied);
    expect(sessionMetadataUnattended(withSessionUnattendedMetadata({}, true))).toBe(true);
  });

  test("reads true only for an exact true value", () => {
    expect(sessionMetadataUnattended(undefined)).toBe(false);
    expect(sessionMetadataUnattended(null)).toBe(false);
    expect(sessionMetadataUnattended([])).toBe(false);
    expect(sessionMetadataUnattended({ [SESSION_UNATTENDED_METADATA_KEY]: "true" })).toBe(false);
    expect(sessionMetadataUnattended({ [SESSION_UNATTENDED_METADATA_KEY]: true })).toBe(true);
  });
});
