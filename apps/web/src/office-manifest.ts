// Opengeni's own Excel add-in, built from the SDK's add-in kit: one add-in per
// deployment origin, so two deployments never collide in Excel.
import { officeAddinId, officeAddinManifest } from "@opengeni/sdk/office";

export { OFFICE_MANIFEST_PATH } from "@opengeni/sdk/office";

/** The add-in's id for a deployment origin (unchanged since the add-in shipped). */
export function opengeniOfficeAddinId(origin: string): Promise<string> {
  return officeAddinId(`opengeni-office-addin:${origin}`);
}

/** The manifest for this deployment's add-in, served from `origin`. */
export async function opengeniOfficeManifest(origin: string): Promise<string> {
  return officeAddinManifest({
    id: await opengeniOfficeAddinId(origin),
    name: "Opengeni",
    description: `Chat with your Opengeni agents and let them work in this workbook (${new URL(origin).host}).`,
    tooltip: "Open your Opengeni chats. Agents can work in this workbook while it is open.",
    origin,
  });
}
