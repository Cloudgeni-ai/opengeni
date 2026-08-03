import { describe, expect, test } from "bun:test";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_FULL_SCOPE,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  googleDriveOAuthScopeDecision,
  googleDriveScopesAllowCapability,
} from "../src/google-drive";

describe("Google Drive OAuth scope capabilities", () => {
  test("maps read-only and stronger full-Drive grants to recursive source access", () => {
    for (const scope of [GOOGLE_DRIVE_READONLY_SCOPE, GOOGLE_DRIVE_FULL_SCOPE]) {
      expect(googleDriveOAuthScopeDecision([scope])).toEqual({
        accessMode: "readonly",
        capabilities: [
          "picker_file_read",
          "source_metadata_discovery",
          "source_content_read",
          "recursive_source_sync",
        ],
      });
    }
  });

  test("keeps metadata-only and picker-file access narrower than recursive sync", () => {
    expect(googleDriveOAuthScopeDecision([GOOGLE_DRIVE_METADATA_READONLY_SCOPE])).toEqual({
      accessMode: "metadata_readonly",
      capabilities: ["source_metadata_discovery"],
    });
    expect(googleDriveOAuthScopeDecision([GOOGLE_DRIVE_FILE_SCOPE])).toEqual({
      accessMode: null,
      capabilities: ["picker_file_read"],
    });
    expect(
      googleDriveOAuthScopeDecision([
        GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
        GOOGLE_DRIVE_FILE_SCOPE,
      ]),
    ).toEqual({
      accessMode: "metadata_readonly",
      capabilities: ["picker_file_read", "source_metadata_discovery"],
    });
  });

  test("fails closed for partial, unrelated, and malformed grants", () => {
    for (const scopes of [
      [],
      ["openid", "email"],
      [` ${GOOGLE_DRIVE_READONLY_SCOPE}`],
      [`${GOOGLE_DRIVE_READONLY_SCOPE} `],
      [GOOGLE_DRIVE_FILE_SCOPE, "https://www.googleapis.com/auth/drive.meet.readonly"],
    ]) {
      expect(googleDriveScopesAllowCapability(scopes, "recursive_source_sync")).toBeFalse();
    }
  });

  test("is deterministic for duplicate grants and ignores unrelated incremental scopes", () => {
    expect(
      googleDriveOAuthScopeDecision([
        GOOGLE_DRIVE_READONLY_SCOPE,
        "openid",
        GOOGLE_DRIVE_READONLY_SCOPE,
        "email",
      ]),
    ).toEqual(googleDriveOAuthScopeDecision([GOOGLE_DRIVE_READONLY_SCOPE]));
  });
});
