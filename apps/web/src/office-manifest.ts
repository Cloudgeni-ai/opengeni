// Opengeni's own Excel add-in, built from the SDK's add-in kit: one add-in per
// deployment origin, so two deployments never collide in Excel.
import { officeAddinId, officeAddinManifest } from "@opengeni/sdk/office";

export { OFFICE_MANIFEST_PATH } from "@opengeni/sdk/office";

/** The add-in's id for a deployment origin (unchanged since the add-in shipped). */
export function opengeniOfficeAddinId(origin: string): Promise<string> {
  return officeAddinId(`opengeni-office-addin:${origin}`);
}

/**
 * Publisher details for a deployment that lists its add-in in Microsoft's
 * add-in store: the provider name must match the store publisher, and the
 * support URL must be a public page with a way to get help.
 */
export type OfficeManifestPublisher = {
  providerName?: string;
  supportUrl?: string;
};

/** Publisher details from `OPENGENI_OFFICE_ADDIN_PROVIDER_NAME` and `OPENGENI_OFFICE_ADDIN_SUPPORT_URL`. */
export function officeManifestPublisherFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): OfficeManifestPublisher {
  const value = (name: string) => env[name]?.trim() || undefined;
  return {
    providerName: value("OPENGENI_OFFICE_ADDIN_PROVIDER_NAME"),
    supportUrl: value("OPENGENI_OFFICE_ADDIN_SUPPORT_URL"),
  };
}

/** The manifest for this deployment's add-in, served from `origin`. */
export async function opengeniOfficeManifest(
  origin: string,
  publisher: OfficeManifestPublisher = {},
): Promise<string> {
  return officeAddinManifest({
    id: await opengeniOfficeAddinId(origin),
    name: "Opengeni",
    description: `Chat with your Opengeni agents and let them work in this workbook (${new URL(origin).host}).`,
    tooltip: "Open your Opengeni chats. Agents can work in this workbook while it is open.",
    origin,
    providerName: publisher.providerName,
    supportUrl: publisher.supportUrl ?? new URL("/excel", origin).toString(),
  });
}
