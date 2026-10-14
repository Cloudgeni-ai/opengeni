import { createHash } from "node:crypto";
import { stableJson } from "@opengeni/contracts";

export function connectorActionFingerprint(input: {
  workspaceId: string;
  connectionId: string;
  serverId: string;
  toolName: string;
  actionName: string;
  arguments: unknown;
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        serverId: input.serverId,
        toolName: input.toolName,
        actionName: input.actionName,
        arguments: input.arguments ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}
