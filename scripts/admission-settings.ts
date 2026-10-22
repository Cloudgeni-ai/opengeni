import { getSettings } from "@opengeni/config";

/**
 * Print the user-admission policy exactly as this release's config parser reads
 * it, plus the deployment revision. Deployment verifiers run this inside a live
 * API container to prove the serving policy, which a bundled image cannot do by
 * importing `@opengeni/config` by name. Output is a single JSON line; it never
 * includes credentials or other settings.
 */
export function admissionSettingsReport(env: NodeJS.ProcessEnv = process.env) {
  const settings = getSettings(env);
  return {
    emails: settings.allowedUserEmails ?? null,
    signupTrialMaster: settings.verifiedSignupTrialCreditsEnabled,
    sourceSha: env.OPENGENI_DEPLOYMENT_REVISION ?? null,
  };
}

if (import.meta.main) console.log(JSON.stringify(admissionSettingsReport()));
