import { z } from "zod";

export const ConnectorToolPermission = z.enum(["allow", "ask", "block"]);
export type ConnectorToolPermission = z.infer<typeof ConnectorToolPermission>;

export const ConnectorToolPermissionEntry = z.object({
  name: z.string().min(1).max(512),
  title: z.string().optional(),
  description: z.string().optional(),
  group: z.enum(["read", "write", "other"]),
  permission: ConnectorToolPermission,
  inherited: z.boolean(),
  approvalRequired: z.boolean(),
});
export type ConnectorToolPermissionEntry = z.infer<typeof ConnectorToolPermissionEntry>;

export const ConnectorToolPermissionsResponse = z.object({
  connectionId: z.string(),
  serverId: z.string(),
  defaultPermission: ConnectorToolPermission.nullable(),
  tools: z.array(ConnectorToolPermissionEntry),
  discoveryError: z.string().nullable(),
  canManage: z.boolean(),
});
export type ConnectorToolPermissionsResponse = z.infer<typeof ConnectorToolPermissionsResponse>;

// Group changes name the currently displayed tools explicitly. MCP annotations
// organize the UI only; they never grant future tools permission automatically.
export const UpdateConnectorToolPermissionsRequest = z
  .object({
    connectionId: z.string().min(1).max(512),
    toolNames: z.array(z.string().min(1).max(512)).min(1).max(2048),
    permission: ConnectorToolPermission,
  })
  .strict();
export type UpdateConnectorToolPermissionsRequest = z.infer<
  typeof UpdateConnectorToolPermissionsRequest
>;
