import type { McpServerConnectionRef } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";

/** Reject retired authority sources instead of aliasing them to native IDs. */
export function assertNativeMcpConnectionRef(
  connectionRef: McpServerConnectionRef | null | undefined,
): void {
  if (connectionRef?.authoritySource === "host") {
    throw new HTTPException(422, {
      message:
        "host-owned MCP connection refs are no longer supported; select an ordinary native connection",
    });
  }
}
