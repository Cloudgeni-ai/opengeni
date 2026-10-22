import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Android push needs the Firebase project's client file (google-services.json).
 * It belongs to whoever ships the build, so builds point at it with
 * OPENGENI_GOOGLE_SERVICES_FILE instead of committing it. Without it the app
 * runs normally and only Android push registration is unavailable.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const googleServicesFile = process.env.OPENGENI_GOOGLE_SERVICES_FILE;
  return {
    ...config,
    name: config.name ?? "Opengeni",
    slug: config.slug ?? "opengeni",
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  };
};
