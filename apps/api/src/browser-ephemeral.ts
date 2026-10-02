import { createHmac } from "node:crypto";
import type { BrowserSession, CreateBrowserSessionRequest } from "@opengeni/contracts";
import { BrowserControlUnsupportedError } from "@opengeni/runtime/sandbox";

export function assertEphemeralBrowserCreateEnabled(
  request: CreateBrowserSessionRequest,
  enabled: boolean,
): void {
  if (request.storageMode === "ephemeral_context" && !enabled) {
    throw new BrowserControlUnsupportedError(
      "Ephemeral Chromium contexts are disabled by the operator",
    );
  }
}

/** Only persisted session identity and server-resolved physical placement enter
 * this private controller partition. Public callers never supply a pool key. */
export function ephemeralBrowserPartition(
  session: BrowserSession,
  placementInstanceId: string,
  rootSecret: string,
): string {
  if (session.placement.kind !== "sandbox_group")
    throw new BrowserControlUnsupportedError(
      "Ephemeral contexts require a managed sandbox placement",
    );
  return createHmac("sha256", rootSecret)
    .update(
      JSON.stringify({
        version: "ephemeral-chromium-headless-default-egress-v1",
        accountId: session.accountId,
        workspaceId: session.workspaceId,
        ownerSubjectId: session.createdBySubjectId,
        sandboxGroupId: session.placement.sandboxGroupId,
        placementInstanceId,
      }),
    )
    .digest("hex");
}
