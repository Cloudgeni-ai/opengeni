#!/usr/bin/env bun
import {
  configuredGoogleDriveSyncLimits,
  getSettings,
  googleDriveOAuthCallbackUrl,
  googleDriveProviderRetryOptions,
  type Settings,
} from "@opengeni/config";

type ReadinessCheck = {
  id: string;
  status: "pass" | "block";
  message: string;
};

export type GoogleDriveReleaseReadiness = {
  schema: "opengeni.google-drive-release-readiness.v1";
  status: "ready" | "blocked";
  providerCallsPerformed: false;
  checks: ReadinessCheck[];
  runtime: {
    callbackUrl: string | null;
    syncLimits: ReturnType<typeof configuredGoogleDriveSyncLimits>;
    providerRetry: ReturnType<typeof googleDriveProviderRetryOptions>;
  };
  pendingApprovalGates: string[];
};

export function buildGoogleDriveReleaseReadiness(settings: Settings): GoogleDriveReleaseReadiness {
  const callbackUrl = googleDriveOAuthCallbackUrl(settings.publicBaseUrl);
  const checks: ReadinessCheck[] = [
    check(
      "integrations_enabled",
      settings.integrationsEnabled,
      "OPENGENI_INTEGRATIONS_ENABLED must be true.",
    ),
    check(
      "oauth_client_present",
      Boolean(settings.googleDriveClientId && settings.googleDriveClientSecret),
      "Both Google Drive OAuth client settings must be present in the runtime Secret.",
    ),
    check(
      "oauth_state_secret_present",
      Boolean(settings.integrationsStateSecret),
      "OPENGENI_INTEGRATIONS_STATE_SECRET must be present in the runtime Secret.",
    ),
    check(
      "credential_encryption_present",
      Boolean(settings.environmentsEncryptionKey),
      "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY must be present in the runtime Secret.",
    ),
    check(
      "public_callback_origin",
      Boolean(callbackUrl),
      "OPENGENI_PUBLIC_BASE_URL must define a credential-free OAuth callback origin without a path, query, or fragment.",
    ),
    check(
      "structured_logs_enabled",
      settings.observabilityStructuredLogs,
      "OPENGENI_OBSERVABILITY_STRUCTURED_LOGS must be true for release acceptance.",
    ),
    check(
      "metrics_enabled",
      settings.observabilityMetricsEnabled,
      "OPENGENI_OBSERVABILITY_METRICS_ENABLED must be true for release acceptance.",
    ),
  ];
  return {
    schema: "opengeni.google-drive-release-readiness.v1",
    status: checks.some((candidate) => candidate.status === "block") ? "blocked" : "ready",
    providerCallsPerformed: false,
    checks,
    runtime: {
      callbackUrl,
      syncLimits: configuredGoogleDriveSyncLimits(settings),
      providerRetry: googleDriveProviderRetryOptions(settings),
    },
    pendingApprovalGates: [
      "merged declared Drive source-security dependency",
      "explicit human approval for non-production real-provider acceptance",
      "separate explicit human approval for deployment or production live-provider acceptance",
    ],
  };
}

function check(id: string, passes: boolean, message: string): ReadinessCheck {
  return { id, status: passes ? "pass" : "block", message };
}

if (import.meta.main) {
  try {
    const result = buildGoogleDriveReleaseReadiness(getSettings());
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "ready" ? 0 : 2;
  } catch {
    console.log(
      JSON.stringify(
        {
          schema: "opengeni.google-drive-release-readiness.v1",
          status: "blocked",
          providerCallsPerformed: false,
          checks: [
            {
              id: "configuration_parse",
              status: "block",
              message:
                "OpenGeni runtime configuration is invalid; inspect the secret-safe boot error.",
            },
          ],
        },
        null,
        2,
      ),
    );
    process.exitCode = 3;
  }
}
