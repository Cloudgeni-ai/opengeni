/**
 * Agents recommend a deployment's reviewed integration definition (Outlook
 * Mail, OneDrive, ...) with this capability id prefix; the rest is the
 * definition id, which is also its Connect provider id.
 */
export const INTEGRATION_DEFINITION_CAPABILITY_PREFIX = "api:integration:";

export function integrationDefinitionCapabilityId(definitionId: string): string {
  return `${INTEGRATION_DEFINITION_CAPABILITY_PREFIX}${definitionId}`;
}

export function integrationDefinitionIdFromCapabilityId(capabilityId: string): string | null {
  return capabilityId.startsWith(INTEGRATION_DEFINITION_CAPABILITY_PREFIX)
    ? capabilityId.slice(INTEGRATION_DEFINITION_CAPABILITY_PREFIX.length) || null
    : null;
}
