#!/usr/bin/env bun

export type GoogleDriveReleaseReadiness = {
  schema: "opengeni.google-drive-release-readiness.v2";
  status: "blocked";
  nativeConnectorStatus: "retired";
  providerCallsPerformed: false;
  oauthVerificationStatus: "not_checked";
  checks: {
    id: "native_drive_retired";
    status: "block";
    message: string;
  }[];
  operatorGuide: "docs/google-drive.md";
};

/**
 * Keep the previous release command as an explicit retirement notice. Local
 * credential presence cannot prove Google's preview access or OAuth approval.
 * Do not load configuration: old secrets must never enter this report.
 */
export function buildGoogleDriveReleaseReadiness(): GoogleDriveReleaseReadiness {
  return {
    schema: "opengeni.google-drive-release-readiness.v2",
    status: "blocked",
    nativeConnectorStatus: "retired",
    providerCallsPerformed: false,
    oauthVerificationStatus: "not_checked",
    checks: [
      {
        id: "native_drive_retired",
        status: "block",
        message:
          "Native Google Drive source sync and publishing are retired. Use the personal Drive MCP connection and ordinary agent schedules. This command does not verify Google OAuth approval or MCP readiness; follow docs/google-drive.md before enabling setup.",
      },
    ],
    operatorGuide: "docs/google-drive.md",
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(buildGoogleDriveReleaseReadiness(), null, 2));
  process.exitCode = 2;
}
