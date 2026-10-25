/** The longest organization name the onboarding API accepts. */
const ORGANIZATION_NAME_MAX = 120;

/**
 * The organization a person using Opengeni on their own gets without being
 * asked to invent one: their name, else the start of their email address.
 * They can rename it any time in Organization settings, or by asking in chat.
 */
export function personalOrganizationName(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const fromName = name?.trim() ?? "";
  // Sign-up stores the email as the name when the name field is left empty.
  const usableName = fromName && !fromName.includes("@") ? fromName : "";
  const fromEmail = email?.trim().split("@")[0]?.trim() ?? "";
  const chosen = usableName || fromEmail || "Personal";
  return Array.from(chosen).slice(0, ORGANIZATION_NAME_MAX).join("");
}
