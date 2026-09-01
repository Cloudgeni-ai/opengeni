import type { Settings } from "@opengeni/config";
import type { McpServerConnectionRef } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";

/**
 * Explicit host-owned MCP refs change which credential authority executes an
 * opaque connection id. Admit new external refs only after the operator has
 * completed the two-phase fleet rollout. Readers and inheritance remain
 * tolerant regardless of this switch, and markerless legacy refs retain their
 * bounded non-UUID compatibility path.
 */
export function assertHostMcpAuthoritySourceAdmissionEnabled(
  settings: Pick<Settings, "hostMcpAuthoritySourceAdmissionEnabled">,
  connectionRef: McpServerConnectionRef | null | undefined,
): void {
  if (
    connectionRef?.authoritySource === "host" &&
    !settings.hostMcpAuthoritySourceAdmissionEnabled
  ) {
    throw new HTTPException(422, {
      message:
        "new host-owned MCP connection refs are not admitted; upgrade the complete API/worker/web fleet, then set OPENGENI_HOST_MCP_AUTHORITY_SOURCE_ADMISSION_ENABLED=true",
    });
  }
}
