import { z } from "zod";
import { ConnectorToolPermission } from "./connector-tool-permissions";
import { MCP_MAX_CATALOG_TOOL_ENTRIES } from "./mcp-catalog-limits";

// Host-attached session MCP servers have no catalog capability. Their tool
// permissions are keyed by the same secret-free identity the runtime derives:
// `session-mcp:<serverId>:<sha256(exact url)>`. The host names the server and
// the exact URL it attaches to sessions; Opengeni stores and enforces the rules.
const sessionMcpServerId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const sessionMcpServerUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    },
    { message: "url must be the exact http(s) URL attached to sessions" },
  );
const exactToolName = z
  .string()
  .min(1)
  .max(512)
  .refine((name) => name !== "*" && name === name.trim(), {
    message: "Tool names must be exact and cannot use the server-default wildcard.",
  });

export const SessionMcpToolPermissionsQuery = z
  .object({ serverId: sessionMcpServerId, url: sessionMcpServerUrl })
  .strict();
export type SessionMcpToolPermissionsQuery = z.infer<typeof SessionMcpToolPermissionsQuery>;

/** Saved choices only. Tools without a rule follow `defaultPermission`, then
 * the attaching session's `requireApproval` recommendation, then Allow. */
export const SessionMcpToolPermissionsResponse = z.object({
  connectionId: z.string(),
  serverId: z.string(),
  defaultPermission: ConnectorToolPermission.nullable(),
  tools: z.array(z.object({ toolName: z.string(), permission: ConnectorToolPermission })),
  revision: z.string(),
  canManage: z.boolean(),
  appliesTo: z.literal("next_attempt"),
});
export type SessionMcpToolPermissionsResponse = z.infer<typeof SessionMcpToolPermissionsResponse>;

export const UpdateSessionMcpToolPermissionsRequest = z.discriminatedUnion("target", [
  z
    .object({
      serverId: sessionMcpServerId,
      url: sessionMcpServerUrl,
      target: z.literal("default"),
      permission: ConnectorToolPermission.nullable(),
      expectedRevision: z.string().optional(),
    })
    .strict(),
  z
    .object({
      serverId: sessionMcpServerId,
      url: sessionMcpServerUrl,
      target: z.literal("tools"),
      toolNames: z.array(exactToolName).min(1).max(MCP_MAX_CATALOG_TOOL_ENTRIES),
      permission: ConnectorToolPermission.nullable(),
      expectedRevision: z.string().optional(),
    })
    .strict(),
]);
export type UpdateSessionMcpToolPermissionsRequest = z.infer<
  typeof UpdateSessionMcpToolPermissionsRequest
>;
